/**
 * Folding queued student writes into batches, and taking a batch apart again.
 *
 * Split out of `data/sync.ts`, which talks to Supabase and cannot be loaded
 * outside the app, so the rules can be tested on their own — see
 * `tools/test-student-import.js`. Only types come from the queue's module, and
 * they vanish when this is compiled.
 */
import type { Op } from '@/data/sync';

/**
 * Students per batch.
 *
 * Matches `WRITE_CHUNK` in the API layer, so one queued op is one request for
 * the rows and a couple for the memberships — and one failed op costs a
 * hundred retries at worst, not a whole import.
 */
export const BATCH = 100;

/**
 * The op that results from appending `op` to `tail`, or null if they do not go
 * together.
 *
 * Only ever the queue's last op, and only if nothing has started sending it, so
 * the order of everything in the queue is exactly the order it was asked for.
 * Creates fold into creates and archives into archives; nothing else does,
 * because nothing else is safe to reorder or combine.
 *
 * A create for a student the batch already holds replaces that entry rather
 * than being added beside it. Postgres refuses an upsert that names the same
 * row twice ("cannot affect row a second time"), and the later create is the
 * truer one anyway.
 */
export function foldIntoBatch(tail: Op, op: Op): Op | null {
  if (op.kind === 'student.create') {
    const held =
      tail.kind === 'student.create'
        ? [tail.student]
        : tail.kind === 'student.createMany'
          ? tail.students
          : null;
    if (!held) return null;

    const at = held.findIndex((s) => s.id === op.student.id);
    if (at >= 0) {
      const students = [...held];
      students[at] = op.student;
      return { kind: 'student.createMany', students };
    }
    if (held.length >= BATCH) return null;
    return { kind: 'student.createMany', students: [...held, op.student] };
  }

  if (op.kind === 'student.archive') {
    const held =
      tail.kind === 'student.archive'
        ? [tail.id]
        : tail.kind === 'student.archiveMany'
          ? tail.ids
          : null;
    if (!held) return null;
    if (held.includes(op.id)) return { kind: 'student.archiveMany', ids: held };
    if (held.length >= BATCH) return null;
    return { kind: 'student.archiveMany', ids: [...held, op.id] };
  }

  return null;
}

/**
 * A refused batch as its rows, one op each — or null if it is not a batch.
 *
 * A batch is refused whole: one row that breaks a constraint fails the
 * request for all hundred. Dropping it would cost ninety-nine good students
 * for one bad one, so the rows are retried alone and only the bad one fails.
 *
 * Updates stay `updateMany` of one rather than becoming `student.update`,
 * because the two mean different things for memberships — see
 * `api.updateStudents`.
 */
export function splitBatch(op: Op): Op[] | null {
  switch (op.kind) {
    case 'student.createMany':
      return op.students.length > 1
        ? op.students.map((student) => ({ kind: 'student.create', student }) as const)
        : null;
    case 'student.updateMany':
      return op.patches.length > 1
        ? op.patches.map((p) => ({ kind: 'student.updateMany', patches: [p] }) as const)
        : null;
    case 'student.archiveMany':
      return op.ids.length > 1
        ? op.ids.map((id) => ({ kind: 'student.archive', id }) as const)
        : null;
    default:
      return null;
  }
}

/**
 * How many of the teacher's changes an op stands for.
 *
 * The home screen counts what is still to send. A batch of a hundred students
 * counted as one would tell a teacher who imported four hundred that four
 * things were waiting, which is true and means nothing to them.
 */
export function opWeight(op: Op): number {
  switch (op.kind) {
    case 'student.createMany':
      return op.students.length;
    case 'student.updateMany':
      return op.patches.length;
    case 'student.archiveMany':
      return op.ids.length;
    default:
      return 1;
  }
}

/** Every row an op writes to, by id. Empty for ops about no one row. */
export function idsOf(op: Op): string[] {
  switch (op.kind) {
    case 'student.createMany':
      return op.students.map((s) => s.id);
    case 'student.updateMany':
      return op.patches.map((p) => p.id);
    case 'student.archiveMany':
      return op.ids;
    default: {
      const id =
        'id' in op ? op.id : 'group' in op ? op.group.id : 'student' in op ? op.student.id : null;
      return id ? [id] : [];
    }
  }
}

/** Whether two ops write to any of the same rows. */
export function touchesSameTarget(a: Op, b: Op): boolean {
  const mine = idsOf(a);
  if (!mine.length) return false;
  const theirs = new Set(idsOf(b));
  return mine.some((id) => theirs.has(id));
}

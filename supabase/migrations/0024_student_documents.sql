-- ClassCare 0024 — which document a number is, and one number per student.
--
-- 0014 kept the passport or birth certificate number as one free-text column
-- and said the app had no need to know which document it was. It does now: a
-- passport is required from sixteen and a birth certificate before it, and the
-- form has to ask for the right one.
--
-- The number has also become the student's identity. A roster of four hundred
-- has several children with the same name, and imports used to fold namesakes
-- into one record. One document number belongs to exactly one person, so the
-- importer matches on it and no teacher may hold it twice.
--
-- Additive only. Two nullable columns, a check and a partial index. No existing
-- row is changed: `document_key` starts null everywhere and is written by the
-- app whenever it saves a student, so the uniqueness covers each student from
-- the first time they are saved after this. The index cannot fail to build on
-- existing data, because every key is null when it is created.
--
-- Safe to run on a database with 0001-0023 applied, and safe to run twice.

alter table students add column if not exists document_kind text;

alter table students drop constraint if exists students_document_kind_check;
alter table students
  add constraint students_document_kind_check
  check (document_kind is null or document_kind in ('passport', 'birth_certificate', 'generated'));

-- The number as compared, not as written: capitals, no spaces or punctuation,
-- Cyrillic look-alikes folded to Latin. Computed by the app (`documentKey` in
-- src/lib/studentDocs.ts) rather than here, so the rule lives in one place and
-- does not depend on the database's locale for upper-casing Turkmen letters.
alter table students add column if not exists document_key text;

-- One student per number, per teacher. Per teacher, because two tutors teaching
-- the same child each have their own record of them. Archived students are left
-- out, so a child who left and comes back can be added again.
create unique index if not exists students_teacher_document_key_idx
  on students (teacher_id, document_key)
  where document_key is not null and archived_at is null;

comment on column students.document_kind is
  '`passport` from 16, `birth_certificate` before, `generated` for a code the app '
  'made for a student imported without either. Null on rows saved before 0024.';

comment on column students.document_key is
  'document_id normalised for comparison by the app. Unique per teacher among '
  'active students.';

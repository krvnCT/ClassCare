import { requireOptionalNativeModule } from 'expo';

import type { BeamModuleType } from './Beam.types';

/**
 * Optional on purpose, for the same reason `DeviceSms` is.
 *
 * Android-only — iOS has no equivalent of a Wi-Fi Direct group a stranger can
 * join with a password — so this is `null` there, and `null` on any build made
 * before the module existed, which includes every APK a teacher already has
 * installed. Callers must check before using it.
 */
export default requireOptionalNativeModule<BeamModuleType>('Beam');

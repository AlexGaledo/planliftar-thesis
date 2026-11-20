/**
 * The image (and chosen name) of an upload whose analysis is still running.
 *
 * Kept in IndexedDB keyed by job id so the progress page survives a reload: when
 * the job finishes, the project is saved with its source image even if the user
 * refreshed in between.
 */
import { db } from "./db";

export interface PendingUpload {
  name: string;
  image: Blob;
  fileName: string;
  demo: boolean;
}

const key = (jobId: string) => `pending:${jobId}`;

export async function savePendingUpload(jobId: string, upload: PendingUpload): Promise<void> {
  await db.meta.put({ key: key(jobId), value: upload });
}

export async function getPendingUpload(jobId: string): Promise<PendingUpload | null> {
  const entry = await db.meta.get(key(jobId));
  return (entry?.value as PendingUpload | undefined) ?? null;
}

export async function clearPendingUpload(jobId: string): Promise<void> {
  await db.meta.delete(key(jobId));
}

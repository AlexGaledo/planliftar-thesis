/**
 * A temporary URL for a Blob (e.g. the stored source image), revoked when the
 * Blob changes or the component unmounts so the memory is released.
 */
import { useEffect, useState } from "react";

export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

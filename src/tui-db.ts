import { useEffect, useRef, useState } from 'react';
import type { Database } from 'bun:sqlite';

/**
 * Poll `PRAGMA data_version` at a fixed interval to detect DB writes.
 * Returns a monotonically increasing counter that bumps whenever the
 * DB is written to (even in WAL mode). Components use this as a
 * dependency to re-fetch data.
 *
 * WAL mode writes go to forge.db-wal, so file mtime on forge.db is
 * unreliable. data_version is the correct signal.
 */
export function useDbPoll(db: Database | null, intervalMs: number = 1000): number {
  const [version, setVersion] = useState(0);
  const prevVersionRef = useRef(-1);

  useEffect(() => {
    if (!db) return;

    const check = () => {
      try {
        const row = db.query('PRAGMA data_version').get() as { data_version: number } | null;
        if (row && row.data_version !== prevVersionRef.current) {
          prevVersionRef.current = row.data_version;
          setVersion(v => v + 1);
        }
      } catch {
        // DB may have been closed — ignore
      }
    };

    check();

    const timer = setInterval(check, intervalMs);
    return () => clearInterval(timer);
  }, [db, intervalMs]);

  return version;
}

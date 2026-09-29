/** Most blocks per log query: Arc's public RPC allows 10,000. */
const LOG_RANGE = 10_000n;

/** Walks the chain's blocks in log-query-sized ranges, each block once, resuming where it stopped. */
export interface BlockScanner {
  /**
   * Reads each range from the next unread block through `latest`, oldest first. Without a start
   * block, the first scan reads only `latest`. A range whose `read` throws is read again next scan.
   */
  scan(latest: bigint, read: (fromBlock: bigint, toBlock: bigint) => Promise<void>): Promise<void>;
  /** The next block to read. */
  readonly position: bigint | undefined;
}

export function createBlockScanner(fromBlock?: bigint): BlockScanner {
  let next = fromBlock;
  return {
    get position() {
      return next;
    },

    async scan(latest, read) {
      let from = next ?? latest;
      while (from <= latest) {
        const to = from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest;
        await read(from, to);
        from = to + 1n;
        next = from;
      }
    },
  };
}

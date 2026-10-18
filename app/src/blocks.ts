/** Most blocks per log query: Arc's public RPC allows 10,000. */
const LOG_RANGE = 10_000n;

/** Walks the chain's blocks in log-query-sized ranges, each block once, resuming where it stopped. */
export interface BlockScanner {
  /**
   * Reads each range from the next unread block through `latest`, oldest first. Without a start
   * block, the first scan reads only `latest`. A range whose `read` throws is read again next scan,
   * half as long, down to one block, so a range an RPC can't answer, such as one with too many logs,
   * holds up only the blocks it must. The ranges grow back as reads succeed.
   */
  scan(latest: bigint, read: (fromBlock: bigint, toBlock: bigint) => Promise<void>): Promise<void>;
  /** The next block to read. */
  readonly position: bigint | undefined;
}

export function createBlockScanner(fromBlock?: bigint): BlockScanner {
  let next = fromBlock;
  let span = LOG_RANGE;
  return {
    get position() {
      return next;
    },

    async scan(latest, read) {
      let from = next ?? latest;
      while (from <= latest) {
        const to = from + span - 1n < latest ? from + span - 1n : latest;
        try {
          await read(from, to);
        } catch (error) {
          if (to > from) span = (to - from + 1n) / 2n;
          throw error;
        }
        if (span < LOG_RANGE) span = span * 2n < LOG_RANGE ? span * 2n : LOG_RANGE;
        from = to + 1n;
        next = from;
      }
    },
  };
}

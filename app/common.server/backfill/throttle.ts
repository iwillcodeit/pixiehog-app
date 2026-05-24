import { setTimeout as sleep } from "node:timers/promises";

/** Rate-limit delay between PostHog batch flushes. Uses Node.js timers (runs on Railway, not Vercel). */
export const throttleDelay = (ms: number) => sleep(ms);

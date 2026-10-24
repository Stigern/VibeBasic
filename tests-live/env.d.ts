// The bits of Node the live harness uses (@types/node is not a dependency).
declare const process: { env: Record<string, string | undefined>; stderr: { write(s: string): void } };

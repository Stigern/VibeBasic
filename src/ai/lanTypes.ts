export interface LanNetwork {
  interface: string; address: string; network: string; prefix: number; hostCount: number; note: string;
}
export interface LanServer {
  host: string; port: number; baseUrl: string; kind: string; models: string[]; latencyMs: number; requiresKey: boolean;
}
export interface LanScanRequest { networks: string[]; ports: number[]; linkLocal: boolean; apiKey?: string }
export interface LanProgress { completed: number; total: number; found: number; server?: LanServer }
export interface LanScanOptions { signal?: AbortSignal; onProgress?: (progress: LanProgress) => void }
export interface LanBackend {
  aiLanNetworks(linkLocal: boolean): Promise<LanNetwork[]>;
  aiLanScan(request: LanScanRequest, options?: LanScanOptions): Promise<LanServer[]>;
  loadSettings<T>(key: string): Promise<T | null>;
  saveSettings(key: string, value: unknown): Promise<void>;
}

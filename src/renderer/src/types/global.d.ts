import type { BoardTasksBridge } from '../../../preload/index.d';

declare global {
  interface Window {
    boardtasks: BoardTasksBridge;
  }
}
export {};

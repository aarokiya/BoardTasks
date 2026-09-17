declare module '*.sql?raw' {
  const content: string;
  export default content;
}

declare const __APP_VERSION__: string;

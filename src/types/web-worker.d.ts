declare module 'web-worker' {
  const Worker: {
    new (url: string | URL, options?: WorkerOptions): Worker;
  };
  export default Worker;
}

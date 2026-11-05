/** Python sources are bundled as text by esbuild (loader ".py": "text"). */
declare module "*.py" {
  const source: string;
  export default source;
}

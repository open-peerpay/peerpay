declare module "*.html" {
  const html: unknown;
  export default html;
}

declare module "*.css";

declare module "qrcode/lib/browser" {
  export * from "qrcode";
  export { default } from "qrcode";
}

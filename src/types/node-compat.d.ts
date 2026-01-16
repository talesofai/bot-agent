declare module "node:util" {
  export type TextEncoderEncodeIntoResult = import("util").EncodeIntoResult;
}

declare module "node:tls" {
  type ConnectionOptions = import("tls").ConnectionOptions;
  type KeyObject = import("crypto").KeyObject;
  type TLSSocket = import("tls").TLSSocket;
}

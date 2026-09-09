import type { Request } from "express";

export interface Identity {
  id: string;
  email: string;
}

export interface ArgusRequest extends Request {
  traceId: string;
  identity?: Identity;
}

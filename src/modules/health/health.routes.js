import { Router } from "express";
import mongoose from "mongoose";

export const healthRouter = Router();

healthRouter.get("/live", (req, res) => {
  res.status(200).json({ data: { status: "ok" } });
});

healthRouter.get("/ready", (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ data: { status: ready ? "ready" : "not_ready" } });
});

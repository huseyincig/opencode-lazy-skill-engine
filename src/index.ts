import { Plugin } from "@opencode/plugin";
import { createPlugin } from "./plugin.js";

export default Plugin.define(createPlugin() as unknown as Parameters<typeof Plugin.define>[0]);

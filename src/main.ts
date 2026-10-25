import "./startup.ts";
import { server } from "./api.ts";
import { openWindow } from "./window.ts";

await openWindow(server.url.href);

import { render } from "preact";
import { App } from "./app";
import "../shared/ipc";
import { installBridgeListeners } from "./script-io";

installBridgeListeners();
render(<App />, document.getElementById("app")!);

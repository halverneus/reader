import { render } from "preact";
import { App } from "./app";
import "../shared/ipc";

render(<App />, document.getElementById("app")!);

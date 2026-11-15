import { render } from "solid-js/web";
import { EraseScreen } from "./eraseScreen.tsx";
import "./styles.css";

// The window of a start that erases (ADR 0138, rule 11): no backend, no mail, only main.
render(() => <EraseScreen />, document.getElementById("root") as HTMLElement);

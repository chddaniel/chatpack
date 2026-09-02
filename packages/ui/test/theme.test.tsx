import { describe, expect, it } from "vitest";
import { ChatpackUIThemeProvider } from "../src/theme";

describe("ChatpackUIThemeProvider", () => {
  it("maps semantic theme overrides to package CSS variables", () => {
    const element = ChatpackUIThemeProvider({
      theme: {
        input: "#8d877f",
        bubbleOwn: "#d2f338",
        bubbleOwnMuted: "#3f602a",
        bubbleOwnContrast: "#031919",
        highlight: "#d2f338",
        highlightContrast: "#103225",
        destructive: "#9e2f22",
        online: "#d2f338",
        mentionRing: "#e7b01a",
      },
      children: "Chat",
    });

    expect(element.props.style).toEqual({
      "--chatpack-ui-input": "#8d877f",
      "--chatpack-ui-bubble-own": "#d2f338",
      "--chatpack-ui-bubble-own-muted": "#3f602a",
      "--chatpack-ui-bubble-own-contrast": "#031919",
      "--chatpack-ui-highlight": "#d2f338",
      "--chatpack-ui-highlight-contrast": "#103225",
      "--chatpack-ui-destructive": "#9e2f22",
      "--chatpack-ui-online": "#d2f338",
      "--chatpack-ui-mention-ring": "#e7b01a",
    });
  });
});

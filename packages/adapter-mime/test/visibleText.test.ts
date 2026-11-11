import { describe, expect, it } from "vitest";
import { htmlToText, visibleText } from "../src/index.ts";

const IGNORE = "IGNORE-THE-PERSON";

describe("visibleText (ADR 0052, rule 8)", () => {
  it("equals htmlToText when nothing is hidden", () => {
    const html =
      "<p>Hello &amp; welcome</p><div>Second<br>line</div><!-- c --><script>x()</script>";
    expect(visibleText(html)).toBe(htmlToText(html));
    expect(visibleText(html)).toBe("Hello & welcome\n\nSecond\nline");
  });

  it("drops text hidden inline, and htmlToText still keeps it for search", () => {
    const cases = [
      `<span style="display:none">${IGNORE}</span>`,
      `<span style="DISPLAY : NONE !important">${IGNORE}</span>`,
      `<div style="visibility:hidden">${IGNORE}</div>`,
      `<span style="font-size:0">${IGNORE}</span>`,
      `<span style="font-size:0px;color:#fff">${IGNORE}</span>`,
      `<span style="opacity:0">${IGNORE}</span>`,
      `<div style="mso-hide:all">${IGNORE}</div>`,
      `<div style="max-height:0;overflow:hidden">${IGNORE}</div>`,
      `<div style="width:0px; height:0; overflow:hidden">${IGNORE}</div>`,
      `<p style="text-indent:-9999px">${IGNORE}</p>`,
      `<div style="position:absolute;left:-10000px">${IGNORE}</div>`,
      `<div hidden>${IGNORE}</div>`,
      `<div hidden="until-found">${IGNORE}</div>`,
    ];
    for (const hidden of cases) {
      const html = `<p>Visible</p>${hidden}<p>After</p>`;
      expect(visibleText(html), hidden).toBe("Visible\n\nAfter");
      expect(htmlToText(html), hidden).toContain(IGNORE);
    }
  });

  it("keeps text from boxes that merely look small", () => {
    expect(visibleText('<div style="max-height:0">shown</div>')).toBe("shown");
    expect(visibleText('<span style="font-size:12px">shown</span>')).toBe("shown");
    expect(visibleText('<span style="display:block">shown</span>')).toBe("shown");
  });

  it("hides the whole element, including nested elements of the same name", () => {
    const html = `<div>A<div style="display:none">x<div>y</div>${IGNORE}</div>B</div>`;
    expect(visibleText(html)).toBe("A\nB");
  });

  it("hides what follows an element that never closes", () => {
    expect(visibleText(`<p>A</p><div style="display:none">${IGNORE}`)).toBe("A");
  });

  it("ends a hidden paragraph at the next one, as a browser does", () => {
    expect(visibleText(`<p style="display:none">${IGNORE}<p>shown`)).toBe("shown");
  });

  it("reads hiding from the message's own style block", () => {
    const html = `<style>.pre, #h { display: none } @media print { .p { display:none } }</style>
      <p>Visible</p><span class="x pre">${IGNORE}</span><div id="h">${IGNORE}</div><b class="p">print only</b>`;
    expect(visibleText(html)).toBe("Visible\n\nprint only");
  });

  it("honours a style block rule inside a screen media query", () => {
    const html = `<style>@media screen { .s { font-size: 0 } }</style><i class="s">${IGNORE}</i>ok`;
    expect(visibleText(html)).toBe("ok");
  });

  it("lets an inline style undo a hiding class, and an important rule win", () => {
    const html = `<style>.a{display:none}.b{display:none !important}</style>
      <p class="a" style="display:block">shown</p><p class="b" style="display:block">${IGNORE}</p>`;
    expect(visibleText(html)).toBe("shown");
  });

  it("is not fooled by CSS escapes, comments or entities in the style", () => {
    const cases = [
      `<span style="di\\73 play:none">${IGNORE}</span>`,
      `<span style="display/* x */:none">${IGNORE}</span>`,
      `<span style="display&#58;none">${IGNORE}</span>`,
      `<span style="font-size:&#48;">${IGNORE}</span>`,
    ];
    for (const hidden of cases) expect(visibleText(`a${hidden}b`), hidden).toBe("ab");
  });

  it("does not end a tag at a > inside a quoted attribute", () => {
    const html = `<div title=">" style="display:none">${IGNORE}</div><p>shown</p>`;
    expect(visibleText(html)).toBe("shown");
  });

  it("leaves text that merely looks like a tag", () => {
    expect(visibleText("a < b and c<5")).toBe("a < b and c<5");
  });

  it("does not let void elements open a hidden region", () => {
    expect(visibleText('a<br style="display:none">b<img style="display:none">c')).toBe("a\nbc");
  });

  it("runs in linear time on hostile input", () => {
    const started = performance.now();
    visibleText(`${"<div style='display:none'>".repeat(20_000)}x`);
    visibleText(`${"<".repeat(50_000)}text`);
    visibleText(`<style>${"/*".repeat(50_000)}`);
    visibleText(
      `<style>${".a{display:none}".repeat(20_000)}</style>${'<p class="a">x</p>'.repeat(5_000)}`,
    );
    visibleText(`<p title="${"x".repeat(100_000)}`);
    visibleText(`${"</div>".repeat(50_000)}${"<div hidden>".repeat(10_000)}`);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

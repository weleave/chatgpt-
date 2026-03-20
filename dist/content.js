(() => {
  // src/content.js
  var MESSAGE_TYPE = "EXPORT_CHATGPT_CONTENT";
  var PING_TYPE = "CHATGPT_WORD_EXPORTER_PING";
  if (!globalThis.__chatgptWordExporterContentLoaded) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === PING_TYPE) {
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type !== MESSAGE_TYPE) {
        return void 0;
      }
      try {
        const payload = extractChatContent();
        sendResponse({ ok: true, payload });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "\u5BFC\u51FA\u5931\u8D25\u3002"
        });
      }
      return false;
    });
    globalThis.__chatgptWordExporterContentLoaded = true;
  }
  function extractChatContent() {
    const fragment = getSelectedFragment() ?? getLatestAssistantFragment();
    if (!fragment) {
      throw new Error("\u672A\u627E\u5230\u53EF\u5BFC\u51FA\u7684\u56DE\u7B54\u3002\u8BF7\u5148\u6253\u5F00 ChatGPT \u6216\u540C\u754C\u9762\u955C\u50CF\u7AD9\u7684\u5BF9\u8BDD\uFF0C\u6216\u624B\u52A8\u9009\u4E2D\u4E00\u6BB5\u56DE\u7B54\u3002");
    }
    const blocks = extractBlocks(fragment.root);
    if (!blocks.length) {
      throw new Error("\u8BC6\u522B\u5230\u7684\u5185\u5BB9\u4E3A\u7A7A\u3002");
    }
    return {
      title: cleanTitle(document.title),
      mode: fragment.mode,
      blocks
    };
  }
  function getSelectedFragment() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const root = document.createElement("div");
    let hasContent = false;
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const fragment = selection.getRangeAt(index).cloneContents();
      if (fragment.childNodes.length > 0) {
        root.appendChild(fragment);
        hasContent = true;
      }
    }
    if (!hasContent || !(root.textContent || "").trim()) {
      return null;
    }
    return { mode: "selection", root };
  }
  function getLatestAssistantFragment() {
    const preferredSelectors = ['[data-message-author-role="assistant"]'];
    const fallbackSelectors = ["main article", 'main [class*="markdown"]', "main .prose"];
    const candidates = collectCandidates(preferredSelectors, { requireMarkdownOrMath: false }) || collectCandidates(fallbackSelectors, { requireMarkdownOrMath: true });
    const root = candidates?.at(-1);
    if (!root) {
      return null;
    }
    return { mode: "latest-answer", root: root.cloneNode(true) };
  }
  function collectCandidates(selectors, options) {
    const seen = /* @__PURE__ */ new Set();
    const candidates = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const contentNode = getBestContentNode(element);
        if (!contentNode || seen.has(contentNode)) {
          continue;
        }
        if (!isVisible(contentNode) || isInsideChromeUi(contentNode)) {
          continue;
        }
        if (!looksLikeAssistantContent(contentNode, options)) {
          continue;
        }
        seen.add(contentNode);
        candidates.push(contentNode);
      }
    }
    return candidates.length ? candidates : null;
  }
  function looksLikeAssistantContent(element, options = {}) {
    const textLength = getVisibleText(element).trim().length;
    const hasMath = Boolean(element.querySelector(".katex, .katex-display, mjx-container, math"));
    const hasMarkdown = Boolean(element.querySelector(".markdown, [class*='markdown'], .prose, pre, ul, ol"));
    if (textLength < 20 && !hasMath) {
      return false;
    }
    if (options.requireMarkdownOrMath && !hasMath && !hasMarkdown) {
      return false;
    }
    return true;
  }
  function getBestContentNode(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    const inner = element.querySelector(
      '.markdown, [class*="markdown"], .prose, [data-testid*="conversation-turn-content"]'
    );
    return inner instanceof HTMLElement ? inner : element;
  }
  function isVisible(element) {
    return element.getClientRects().length > 0;
  }
  function isInsideChromeUi(element) {
    return Boolean(element.closest("nav, header, footer, aside, dialog, [role='dialog']"));
  }
  function getVisibleText(element) {
    return (element.innerText || element.textContent || "").replace(/\u00a0/g, " ");
  }
  function cleanTitle(title) {
    return title.replace(/\s*-\s*ChatGPT\s*$/i, "").trim() || "ChatGPT";
  }
  function extractBlocks(root) {
    const blocks = [];
    for (const child of Array.from(root.childNodes)) {
      collectBlock(child, blocks);
    }
    if (!blocks.length) {
      const inlines = finalizeInlines(extractInlines(root));
      if (inlines.length) {
        blocks.push({ type: "paragraph", inlines });
      }
    }
    return blocks.filter(hasBlockContent);
  }
  function collectBlock(node, blocks) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = collapseWhitespace(node.textContent || "");
      if (text.trim()) {
        blocks.push({
          type: "paragraph",
          inlines: [{ type: "text", text }]
        });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const element = node;
    if (shouldIgnoreElement(element)) {
      return;
    }
    if (isMathElement(element)) {
      const mathInline = extractMathInline(element);
      if (mathInline) {
        blocks.push({
          type: "paragraph",
          inlines: [mathInline]
        });
      }
      return;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "p") {
      pushParagraphBlock(blocks, extractInlines(element));
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const inlines = finalizeInlines(extractInlines(element));
      if (inlines.length) {
        blocks.push({ type: "heading", level, inlines });
      }
      return;
    }
    if (tag === "pre") {
      const text = (element.innerText || element.textContent || "").replace(/\r/g, "");
      if (text.trim()) {
        blocks.push({ type: "code", text });
      }
      return;
    }
    if (tag === "ul" || tag === "ol") {
      const listBlock = extractListBlock(element, tag === "ol");
      if (listBlock.items.length) {
        blocks.push(listBlock);
      }
      return;
    }
    if (tag === "blockquote") {
      const inlines = finalizeInlines(extractInlines(element));
      if (inlines.length) {
        blocks.push({ type: "quote", inlines });
      }
      return;
    }
    if (tag === "table") {
      blocks.push(...extractTableBlocks(element));
      return;
    }
    if (tag === "hr") {
      blocks.push({ type: "divider" });
      return;
    }
    if (hasBlockChildren(element)) {
      for (const child of Array.from(element.childNodes)) {
        collectBlock(child, blocks);
      }
      return;
    }
    pushParagraphBlock(blocks, extractInlines(element));
  }
  function hasBlockChildren(element) {
    const blockTags = /* @__PURE__ */ new Set([
      "article",
      "blockquote",
      "div",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "li",
      "ol",
      "p",
      "pre",
      "section",
      "table",
      "ul"
    ]);
    return Array.from(element.children).some((child) => {
      if (!(child instanceof HTMLElement)) {
        return false;
      }
      return blockTags.has(child.tagName.toLowerCase()) || isMathElement(child);
    });
  }
  function extractListBlock(listElement, ordered) {
    const items = [];
    for (const child of Array.from(listElement.children)) {
      if (!(child instanceof HTMLLIElement)) {
        continue;
      }
      const clone = child.cloneNode(true);
      for (const nestedList of Array.from(clone.querySelectorAll("ul, ol"))) {
        nestedList.remove();
      }
      const inlines = finalizeInlines(extractInlines(clone));
      if (inlines.length) {
        items.push({ inlines });
      }
    }
    return { type: "list", ordered, items };
  }
  function extractTableBlocks(tableElement) {
    const blocks = [];
    const rows = Array.from(tableElement.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th, td")).map((cell) => collapseWhitespace(cell.innerText || cell.textContent || "").trim()).filter(Boolean);
      if (!cells.length) {
        continue;
      }
      blocks.push({
        type: "paragraph",
        inlines: [{ type: "text", text: cells.join(" | ") }]
      });
    }
    return blocks;
  }
  function pushParagraphBlock(blocks, inlines) {
    const normalized = finalizeInlines(inlines);
    if (normalized.length) {
      blocks.push({ type: "paragraph", inlines: normalized });
    }
  }
  function extractInlines(node, style = {}, inlines = []) {
    if (node.nodeType === Node.TEXT_NODE) {
      pushTextInline(inlines, node.textContent || "", style);
      return inlines;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return inlines;
    }
    const element = node;
    if (shouldIgnoreElement(element)) {
      return inlines;
    }
    if (isMathElement(element)) {
      const mathInline = extractMathInline(element);
      if (mathInline) {
        inlines.push(mathInline);
      }
      return inlines;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "br") {
      inlines.push({ type: "break" });
      return inlines;
    }
    if (tag === "img") {
      const alt = element.getAttribute("alt") || "[\u56FE\u7247]";
      pushTextInline(inlines, alt, style);
      return inlines;
    }
    const nextStyle = {
      ...style,
      bold: style.bold || tag === "strong" || tag === "b",
      italics: style.italics || tag === "em" || tag === "i",
      underline: style.underline || tag === "u",
      strike: style.strike || tag === "s" || tag === "strike" || tag === "del",
      code: style.code || tag === "code",
      superScript: style.superScript || tag === "sup",
      subScript: style.subScript || tag === "sub",
      link: tag === "a" ? element.getAttribute("href") || style.link : style.link
    };
    for (const child of Array.from(element.childNodes)) {
      extractInlines(child, nextStyle, inlines);
    }
    return inlines;
  }
  function pushTextInline(inlines, rawText, style) {
    const text = style.code ? rawText.replace(/\r/g, "") : collapseWhitespace(rawText);
    if (!text) {
      return;
    }
    const inline = {
      type: "text",
      text
    };
    for (const key of ["bold", "italics", "underline", "strike", "code", "link", "superScript", "subScript"]) {
      if (style[key]) {
        inline[key] = style[key];
      }
    }
    inlines.push(inline);
  }
  function collapseWhitespace(text) {
    return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  }
  function finalizeInlines(inlines) {
    const normalized = [];
    for (const inline of inlines) {
      if (inline.type === "text") {
        const text = inline.code ? inline.text : inline.text.replace(/[ \t\f\v]+/g, " ");
        if (!text) {
          continue;
        }
        const cleanInline = { ...inline, text };
        const previous = normalized.at(-1);
        if (previous?.type === "text" && sameTextStyle(previous, cleanInline)) {
          previous.text += cleanInline.text;
        } else {
          normalized.push(cleanInline);
        }
        continue;
      }
      if (inline.type === "break") {
        if (normalized.at(-1)?.type !== "break") {
          normalized.push(inline);
        }
        continue;
      }
      normalized.push(inline);
    }
    trimTextEdges(normalized);
    return normalized.filter((inline) => inline.type !== "text" || inline.text.length > 0);
  }
  function trimTextEdges(inlines) {
    const first = inlines[0];
    const last = inlines.at(-1);
    if (first?.type === "text" && !first.code) {
      first.text = first.text.replace(/^\s+/, "");
    }
    if (last?.type === "text" && !last.code) {
      last.text = last.text.replace(/\s+$/, "");
    }
  }
  function sameTextStyle(left, right) {
    return left.bold === right.bold && left.italics === right.italics && left.underline === right.underline && left.strike === right.strike && left.code === right.code && left.link === right.link && left.superScript === right.superScript && left.subScript === right.subScript;
  }
  function isMathElement(element) {
    const isMathMlElement = typeof MathMLElement !== "undefined" && element instanceof MathMLElement;
    if (!(element instanceof HTMLElement || isMathMlElement)) {
      return false;
    }
    if (element.tagName.toLowerCase() === "math") {
      return true;
    }
    if (element.matches(".katex, .katex-display, mjx-container, .MathJax") || element.querySelector(".katex-mathml math, mjx-assistive-mml math")) {
      return true;
    }
    return false;
  }
  function extractMathInline(element) {
    const annotation = element.querySelector(
      'annotation[encoding="application/x-tex"], annotation[encoding="TeX"], script[type^="math/tex"]'
    );
    const mathElement = element.tagName.toLowerCase() === "math" ? element : element.querySelector(".katex-mathml math, mjx-assistive-mml math, math");
    const latex = normalizeLatex(annotation?.textContent || "");
    const mathml = mathElement ? ensureMathMlNamespace(mathElement.outerHTML) : "";
    if (!latex && !mathml) {
      return null;
    }
    return {
      type: "math",
      display: Boolean(element.closest(".katex-display, [display='block']")),
      latex,
      mathml
    };
  }
  function normalizeLatex(latex) {
    return latex.replace(/\u00a0/g, " ").trim();
  }
  function ensureMathMlNamespace(mathml) {
    if (!mathml) {
      return "";
    }
    if (mathml.includes("xmlns=")) {
      return mathml;
    }
    return mathml.replace(
      /^<math(\s|>)/,
      '<math xmlns="http://www.w3.org/1998/Math/MathML"$1'
    );
  }
  function shouldIgnoreElement(element) {
    const tag = element.tagName.toLowerCase();
    if (["button", "input", "textarea", "select", "svg", "path", "style", "script", "noscript"].includes(tag)) {
      return true;
    }
    if (element.getAttribute("aria-hidden") === "true" && !isMathElement(element)) {
      return true;
    }
    if (element.hasAttribute("data-message-id")) {
      return false;
    }
    return Boolean(
      element.closest?.("[data-testid='composer-footer-actions'], [data-testid='conversation-turn-actions']")
    );
  }
  function hasBlockContent(block) {
    if (block.type === "paragraph" || block.type === "heading" || block.type === "quote") {
      return block.inlines.length > 0;
    }
    if (block.type === "code") {
      return block.text.trim().length > 0;
    }
    if (block.type === "list") {
      return block.items.length > 0;
    }
    return true;
  }
})();

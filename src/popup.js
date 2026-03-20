import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import {
  convertLatex2Math,
  convertMathMl2Math,
  mathJaxReady,
} from "@hungknguyen/docx-math-converter";

const MESSAGE_TYPE = "EXPORT_CHATGPT_CONTENT";
const PING_TYPE = "CHATGPT_WORD_EXPORTER_PING";
const exportButton = document.querySelector("#exportButton");
const statusNode = document.querySelector("#status");

exportButton.addEventListener("click", () => {
  void exportCurrentAnswer();
});

async function exportCurrentAnswer() {
  setStatus("正在读取页面内容…", false, true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id || !isInjectablePage(tab.url)) {
      throw new Error("请先打开 ChatGPT 或同界面镜像站的对话页面。");
    }

    const response = await requestExportPayload(tab.id);

    if (!response?.ok) {
      throw new Error(response?.error || "页面内容提取失败。");
    }

    if (containsLatexOnlyMath(response.payload.blocks)) {
      setStatus("正在准备公式转换引擎…", false, true);
      await mathJaxReady();
    }

    setStatus("正在生成 Word 文档…", false, true);
    const documentFile = await buildDocument(response.payload);
    const blob = await Packer.toBlob(documentFile);
    const filename = buildFilename(response.payload.title);

    await downloadBlob(blob, filename);
    setStatus(`已导出 ${filename}`, false, false);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导出失败。", true, false);
  }
}

function isInjectablePage(url) {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

async function requestExportPayload(tabId) {
  try {
    return await sendMessageToTab(tabId, { type: MESSAGE_TYPE });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);

    if (!/Receiving end does not exist|Could not establish connection/i.test(messageText)) {
      throw error;
    }

    setStatus("正在接入当前站点…", false, true);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    await pingTab(tabId);
    return sendMessageToTab(tabId, { type: MESSAGE_TYPE });
  }
}

async function pingTab(tabId) {
  await sendMessageToTab(tabId, { type: PING_TYPE });
}

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);

    if (/Receiving end does not exist|Could not establish connection/i.test(messageText)) {
      throw new Error("当前页面还没有接入导出脚本。");
    }

    throw error;
  }
}

function containsLatexOnlyMath(blocks) {
  return blocks.some((block) => {
    if (Array.isArray(block.inlines)) {
      return block.inlines.some((inline) => inline.type === "math" && !inline.mathml && inline.latex);
    }

    if (block.type === "list") {
      return block.items.some((item) =>
        item.inlines.some((inline) => inline.type === "math" && !inline.mathml && inline.latex),
      );
    }

    return false;
  });
}

async function buildDocument(payload) {
  const children = [];

  for (const block of payload.blocks) {
    const blockParagraphs = await convertBlock(block);
    children.push(...blockParagraphs);
  }

  return new Document({
    numbering: {
      config: [
        {
          reference: "chatgpt-numbered",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
            },
          ],
        },
        {
          reference: "chatgpt-bulleted",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
            },
          ],
        },
      ],
    },
    sections: [
      {
        children,
      },
    ],
  });
}

async function convertBlock(block) {
  if (block.type === "paragraph") {
    return [new Paragraph(await createParagraphOptions(block.inlines))];
  }

  if (block.type === "heading") {
    return [
      new Paragraph({
        ...(await createParagraphOptions(block.inlines)),
        heading: mapHeadingLevel(block.level),
      }),
    ];
  }

  if (block.type === "quote") {
    return [
      new Paragraph({
        ...(await createParagraphOptions(block.inlines)),
        indent: { left: 480 },
      }),
    ];
  }

  if (block.type === "code") {
    return [
      new Paragraph({
        spacing: { before: 160, after: 160 },
        children: createCodeRuns(block.text),
      }),
    ];
  }

  if (block.type === "list") {
    const reference = block.ordered ? "chatgpt-numbered" : "chatgpt-bulleted";

    return Promise.all(
      block.items.map(async (item) => {
        const options = await createParagraphOptions(item.inlines);
        return new Paragraph({
          ...options,
          numbering: {
            reference,
            level: 0,
          },
        });
      }),
    );
  }

  return [new Paragraph({ spacing: { after: 120 } })];
}

async function createParagraphOptions(inlines) {
  const children = await createInlineChildren(inlines);
  const onlyDisplayMath =
    inlines.length === 1 && inlines[0].type === "math" && Boolean(inlines[0].display);

  return {
    spacing: { after: 180 },
    alignment: onlyDisplayMath ? AlignmentType.CENTER : AlignmentType.LEFT,
    children,
  };
}

async function createInlineChildren(inlines) {
  const children = [];

  for (const inline of inlines) {
    if (inline.type === "text") {
      children.push(...createTextChildren(inline));
      continue;
    }

    if (inline.type === "break") {
      children.push(new TextRun({ text: "", break: 1 }));
      continue;
    }

    if (inline.type === "math") {
      children.push(await createMathChild(inline));
    }
  }

  if (!children.length) {
    children.push(new TextRun(""));
  }

  return children;
}

function createTextChildren(inline) {
  const baseOptions = {
    text: inline.text,
    bold: Boolean(inline.bold),
    italics: Boolean(inline.italics),
    strike: Boolean(inline.strike),
    superScript: Boolean(inline.superScript),
    subScript: Boolean(inline.subScript),
    font: inline.code ? "Consolas" : undefined,
    underline: inline.underline ? {} : undefined,
    color: inline.link ? "0563C1" : undefined,
  };

  const runs = splitIntoRuns(baseOptions);

  if (!inline.link) {
    return runs;
  }

  return [
    new ExternalHyperlink({
      link: inline.link,
      children: runs,
    }),
  ];
}

function splitIntoRuns(options) {
  const lines = options.text.split("\n");

  return lines.map((line, index) => {
    const runText = line || "";
    return new TextRun({
      ...options,
      text: runText,
      break: index === 0 ? undefined : 1,
    });
  });
}

function createCodeRuns(text) {
  return text.split("\n").map((line, index) => {
    const safeLine = line || "";
    return new TextRun({
      text: safeLine,
      font: "Consolas",
      break: index === 0 ? undefined : 1,
    });
  });
}

async function createMathChild(inline) {
  try {
    if (inline.mathml) {
      return convertMathMl2Math(inline.mathml);
    }

    if (inline.latex) {
      return convertLatex2Math(stripMathDelimiters(inline.latex));
    }
  } catch (error) {
    console.warn("Math conversion failed", error);
  }

  return new TextRun({
    text: inline.latex || "[公式]",
    italics: true,
  });
}

function stripMathDelimiters(latex) {
  return latex
    .trim()
    .replace(/^\$\$(.*)\$\$$/s, "$1")
    .replace(/^\$(.*)\$$/s, "$1")
    .replace(/^\\\[(.*)\\\]$/s, "$1")
    .replace(/^\\\((.*)\\\)$/s, "$1")
    .trim();
}

function mapHeadingLevel(level) {
  const levels = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6,
  };

  return levels[level] || HeadingLevel.HEADING_2;
}

function buildFilename(title) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const base = sanitizeFilename(title || "chatgpt-export").slice(0, 48) || "chatgpt-export";

  return `${base}-${stamp}.docx`;
}

function sanitizeFilename(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/\s+/g, "-");
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);

  try {
    if (chrome.downloads?.download) {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: true,
      });
      return;
    }

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function setStatus(message, isError, busy) {
  statusNode.textContent = message;
  statusNode.classList.toggle("error", isError);
  exportButton.disabled = busy;
}

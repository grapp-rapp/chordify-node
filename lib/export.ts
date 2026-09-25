import type { Arrangement } from "./types";

export function baseName(source: string) {
  return (source.replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim() || "transcription").slice(0, 60);
}

function download(data: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function exportMidi(arr: Arrangement, source: string) {
  download(arr.midi as Uint8Array<ArrayBuffer>, "audio/midi", `${baseName(source)}-${arr.instrument}.mid`);
}

export function exportText(arr: Arrangement, source: string) {
  download(arr.text, "text/plain;charset=utf-8", `${baseName(source)}-${arr.instrument}.txt`);
}

/** Render the grand staff offscreen with abcjs and rasterise it for the PDF. */
async function renderSheetImage(abc: string): Promise<HTMLCanvasElement | null> {
  const abcjs = await import("abcjs");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;background:#fff";
  document.body.appendChild(host);
  try {
    abcjs.renderAbc(host, abc, { staffwidth: 740, paddingleft: 10, paddingright: 10 });
    const svg = host.querySelector("svg");
    if (!svg) return null;
    const w = Number(svg.getAttribute("width")) || svg.getBoundingClientRect().width;
    const h = Number(svg.getAttribute("height")) || svg.getBoundingClientRect().height;
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG rasterisation failed"));
      img.src = url;
    });
    URL.revokeObjectURL(url);
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    host.remove();
  }
}

export async function exportPdf(arr: Arrangement, source: string) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("ChordifyNode Transcription", margin, y + 8);
  y += 30;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(
    `${source}  ·  ${arr.instrument === "piano" ? "Piano" : "Guitar (EADGBE)"}  ·  ${arr.tempo} BPM  ·  4/4  ·  Key: ${arr.key}`,
    margin,
    y,
  );
  doc.setTextColor(0);
  y += 20;

  if (arr.instrument === "piano") {
    const canvas = await renderSheetImage(arr.abc).catch(() => null);
    if (canvas) {
      // Slice the tall sheet image across pages.
      const drawW = pageW - margin * 2;
      const pxPerPt = canvas.width / drawW;
      let srcY = 0;
      while (srcY < canvas.height) {
        const availPt = pageH - margin - y;
        const sliceH = Math.min(canvas.height - srcY, Math.floor(availPt * pxPerPt));
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = sliceH;
        slice.getContext("2d")!.drawImage(canvas, 0, srcY, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        doc.addImage(slice.toDataURL("image/jpeg", 0.88), "JPEG", margin, y, drawW, sliceH / pxPerPt);
        srcY += sliceH;
        if (srcY < canvas.height) {
          doc.addPage();
          y = margin;
        }
      }
      doc.addPage();
      y = margin;
    }
  }

  // Text body (tab or note list) in a monospace font, paginated.
  doc.setFont("courier", "normal");
  const fontSize = arr.instrument === "guitar" ? 8 : 8.5;
  doc.setFontSize(fontSize);
  const lineH = fontSize * 1.3;
  const body = arr.text.split("\n").slice(arr.instrument === "guitar" ? 3 : 3);
  for (const raw of body) {
    const lines = doc.splitTextToSize(raw || " ", pageW - margin * 2) as string[];
    for (const line of lines) {
      if (y + lineH > pageH - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += lineH;
    }
  }
  download(doc.output("arraybuffer"), "application/pdf", `${baseName(source)}-${arr.instrument}.pdf`);
}

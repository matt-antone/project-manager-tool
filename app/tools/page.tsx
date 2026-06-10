"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

const MAX_INPUT_LENGTH = 2048;

export default function ToolsPage() {
  const [value, setValue] = useState("");
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();

  useEffect(() => {
    if (!trimmed) {
      setDataUrl(null);
      setError(null);
      return;
    }

    let cancelled = false;

    QRCode.toDataURL(trimmed, { width: 320, margin: 2, errorCorrectionLevel: "M" })
      .then((url) => {
        if (cancelled) return;
        setDataUrl(url);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setDataUrl(null);
        setError("Could not generate a QR code for that input.");
      });

    return () => {
      cancelled = true;
    };
  }, [trimmed]);

  return (
    <main className="toolsPage">
      <header className="toolsPageHeader">
        <h1 className="toolsPageTitle">Tools</h1>
        <p className="toolsPageSubtitle">A small kit of utilities. More to come.</p>
      </header>

      <section className="toolsCard" aria-labelledby="qr-tool-heading">
        <h2 id="qr-tool-heading" className="toolsCardTitle">
          QR Code Generator
        </h2>
        <p className="toolsCardHint">Type or paste any text or URL to get a downloadable QR code.</p>

        <label className="toolsFieldLabel" htmlFor="qr-input">
          Text or URL
        </label>
        <textarea
          id="qr-input"
          className="toolsInput"
          value={value}
          onChange={(event) => setValue(event.target.value.slice(0, MAX_INPUT_LENGTH))}
          placeholder="https://example.com"
          rows={3}
          spellCheck={false}
        />

        {error ? <p className="toolsError">{error}</p> : null}

        {dataUrl ? (
          <div className="toolsQrResult">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="toolsQrImage" src={dataUrl} alt="Generated QR code" width={320} height={320} />
            <a className="themeHeaderButton themeHeaderButtonPrimary" href={dataUrl} download="qr-code.png">
              Download PNG
            </a>
          </div>
        ) : (
          <div className="toolsQrPlaceholder" aria-hidden>
            QR code preview appears here.
          </div>
        )}
      </section>
    </main>
  );
}

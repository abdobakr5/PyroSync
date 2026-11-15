import { useState } from "react";
import { Badge, Button, Icon, Modal } from "./ui";
import {
  downloadBrief,
  downloadCsv,
  fmt,
  valueOf,
  type ExportMeta,
  type Filters,
  type FireRecord,
} from "./data";

const BRIEF_LIMIT = 800;
const PLACEHOLDER =
  "Example: This dataset contains harmonized fire observations for the selected region between 2012 and 2026. It is intended for analyzing seasonal fire activity and sensor detection patterns.";
type Status = "config" | "preparing" | "success" | "error";

/** Compact visual: synthetic records flow along a path into a CSV file glyph. */
function DataFlow({ status }: { status: Status }) {
  const dots = Array.from({ length: 12 }, (_, i) => ({
    x: 14 + (i % 4) * 13,
    y: 18 + Math.floor(i / 4) * 13,
    c: ["#FF693B", "#51D6F0", "#FFC15A"][i % 3],
  }));
  const path = "M64 37 C 104 37, 118 20, 160 20 S 214 37, 238 37";
  return (
    <div className={`data-flow is-${status}`} aria-hidden="true">
      <svg viewBox="0 0 300 74">
        <defs>
          <linearGradient id="flow-line" x1="0" x2="1">
            <stop offset="0" stopColor="#51D6F0" stopOpacity=".1" />
            <stop offset=".5" stopColor="#51D6F0" stopOpacity=".7" />
            <stop offset="1" stopColor="#FF963D" stopOpacity=".8" />
          </linearGradient>
        </defs>
        {dots.map((d, i) => (
          <circle
            key={i}
            cx={d.x}
            cy={d.y}
            r="3.4"
            fill={d.c}
            className="flow-record"
            style={{ animationDelay: `${(i % 4) * 0.15 + Math.floor(i / 4) * 0.1}s` }}
          />
        ))}
        <path
          d={path}
          fill="none"
          stroke="url(#flow-line)"
          strokeWidth="1.5"
          strokeDasharray="3 5"
          className="flow-path"
        />
        {[0, 1, 2, 3, 4].map((i) => (
          <circle key={i} r="2.6" fill={i % 2 ? "#FF963D" : "#8BE7F5"} className="flow-particle">
            <animateMotion
              dur={status === "preparing" ? "0.9s" : "2.6s"}
              begin={`-${i * (status === "preparing" ? 0.18 : 0.52)}s`}
              repeatCount="indefinite"
              path={path}
            />
          </circle>
        ))}
        <g className="flow-file" transform="translate(240 8)">
          <path d="M0 6a6 6 0 0 1 6-6h28l14 14v38a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6Z" />
          <path d="M34 0v8a6 6 0 0 0 6 6h8" className="fold" />
          {status === "success" ? (
            <path d="m14 31 7 7 13-14" className="check" />
          ) : (
            <text x="24" y="40" textAnchor="middle">
              CSV
            </text>
          )}
        </g>
      </svg>
    </div>
  );
}

export function ExportDialog({
  onClose,
  rows,
  filters,
  region,
  dateLabel,
  activeFilters,
  availableFields,
}: {
  onClose: () => void;
  rows: FireRecord[];
  filters: Filters;
  region: string;
  dateLabel: string;
  activeFilters: string[];
  availableFields: string[];
}) {
  const [fields, setFields] = useState(availableFields);
  const [brief, setBrief] = useState("");
  const [status, setStatus] = useState<Status>("config");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ filename: string; bytes: number; rows: number } | null>(
    null,
  );
  const [briefFile, setBriefFile] = useState("");
  const count = valueOf(rows, filters.mode, filters.sensor);
  const meta: ExportMeta = {
    region,
    dateLabel,
    filters: activeFilters,
    fields,
    rows: result?.rows ?? count,
  };
  const unit = filters.mode === "raw" ? "source observations" : "analytical records";

  const validate = () => {
    if (!rows.length)
      return "No records match the current filters. Adjust the dashboard filters before exporting.";
    if (fields.filter((f) => f !== "provenance").length === 0)
      return "Select at least one data field in addition to provenance.";
    if (brief.length > BRIEF_LIMIT)
      return `Shorten the brief to ${BRIEF_LIMIT} characters or fewer.`;
    return "";
  };
  const run = () => {
    const problem = validate();
    if (problem) return setError(problem);
    setError("");
    setStatus("preparing");
    // Let the preparing state paint before the synchronous CSV build.
    window.setTimeout(() => {
      try {
        setResult(downloadCsv(rows, filters, fields));
        setStatus("success");
      } catch (e) {
        setError(e instanceof Error ? e.message : "The CSV file could not be generated.");
        setStatus("error");
      }
    }, 650);
  };
  const title = status === "success" ? "Your CSV is ready" : "Export Your Data";
  return (
    <Modal
      title={title}
      description={
        status === "success"
          ? "The download has started in your browser."
          : "Prepare and download your filtered fire intelligence dataset."
      }
      icon={<Icon name={status === "success" ? "check" : "download"} size={20} />}
      onClose={onClose}
      wide
      className="export-dialog"
    >
      <DataFlow status={status} />
      {status === "config" || status === "preparing" ? (
        <>
          <section className="export-overview" aria-label="Export summary">
            <div className="export-count">
              <strong>{fmt(count)}</strong>
              <span>{unit} to export</span>
            </div>
            <dl>
              <div>
                <dt>Region</dt>
                <dd>{region}</dd>
              </div>
              <div>
                <dt>Date range · UTC</dt>
                <dd>{dateLabel}</dd>
              </div>
              <div>
                <dt>Data mode</dt>
                <dd>
                  <Badge tone={filters.mode === "raw" ? "cyan" : "thermal"}>
                    {filters.mode === "raw" ? "Raw" : "Harmonized"}
                  </Badge>
                </dd>
              </div>
            </dl>
            <div className="export-filters">
              <span>Active filters</span>
              <div>
                {activeFilters.length ? (
                  activeFilters.map((f) => <em key={f}>{f}</em>)
                ) : (
                  <em>None — all observations in range</em>
                )}
              </div>
            </div>
          </section>
          <section className="export-format" aria-label="Export format">
            <div className="format-card" aria-current="true">
              <span className="format-icon">CSV</span>
              <div>
                <strong>Comma-separated values · UTF-8</strong>
                <p>
                  One row per{" "}
                  {filters.mode === "raw"
                    ? "source observation (sensor, satellite, UTC time, coordinates, FRP)"
                    : "harmonized cell/day record, with source IDs"}
                  . Opens in spreadsheets, Python, R, and GIS tools. CSV is the only format
                  currently supported.
                </p>
              </div>
              <Icon name="check" size={16} />
            </div>
            <details className="field-picker">
              <summary>
                Fields included{" "}
                <span>
                  {fields.length} of {availableFields.length}
                </span>
              </summary>
              <div className="export-fields">
                {availableFields.map((field) => (
                  <label key={field}>
                    <input
                      type="checkbox"
                      checked={fields.includes(field)}
                      disabled={field === "provenance" || status === "preparing"}
                      onChange={() =>
                        setFields(
                          fields.includes(field)
                            ? fields.filter((f) => f !== field)
                            : [...fields, field],
                        )
                      }
                    />
                    {field}
                  </label>
                ))}
              </div>
            </details>
          </section>
          <section className="export-brief">
            <label htmlFor="export-brief">
              <strong>Add a Brief (Optional)</strong>
              <span>
                Describe the purpose of this export or add a short note to help explain the dataset.
              </span>
            </label>
            <textarea
              id="export-brief"
              className="input textarea"
              rows={3}
              maxLength={BRIEF_LIMIT + 50}
              placeholder={PLACEHOLDER}
              value={brief}
              disabled={status === "preparing"}
              onChange={(e) => setBrief(e.target.value)}
              aria-describedby="brief-note"
            />
            <div className="brief-meta" id="brief-note">
              <span>
                <Icon name="info" size={13} />
                Saved as a separate <code>-brief.txt</code> documentation file with export metadata
                — never written into the CSV columns.
              </span>
              <span className={brief.length > BRIEF_LIMIT ? "over" : ""}>
                {brief.length}/{BRIEF_LIMIT}
              </span>
            </div>
          </section>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              icon="download"
              onClick={run}
              disabled={status === "preparing"}
            >
              {status === "preparing" ? "Preparing CSV…" : "Download CSV"}
            </Button>
          </div>
          {status === "preparing" && (
            <div className="export-progress" role="status">
              <i />
              <span>Applying filters, writing {fmt(count)} rows, retaining provenance…</span>
            </div>
          )}
        </>
      ) : status === "success" && result ? (
        <div className="export-result" role="status">
          <div className="file-row">
            <span className="file-glyph">CSV</span>
            <div>
              <strong>{result.filename}</strong>
              <span>
                {fmt(result.rows)} rows · {(result.bytes / 1024).toFixed(1)} KB · {filters.mode} ·
                PyroSync Gold NASA MODIS & VIIRS data
              </span>
            </div>
            <Badge tone="success">Downloaded</Badge>
          </div>
          {brief.trim() ? (
            <div className="file-row">
              <span className="file-glyph txt">TXT</span>
              <div>
                <strong>Dataset brief & metadata</strong>
                <span>
                  {briefFile
                    ? `${briefFile} downloaded`
                    : "Your note plus region, dates, filters, fields, and provenance."}
                </span>
              </div>
              <Button
                icon="download"
                onClick={() => setBriefFile(downloadBrief(filters, meta, brief))}
              >
                {briefFile ? "Download again" : "Download brief"}
              </Button>
            </div>
          ) : (
            <p className="muted-note">
              No brief was added. The CSV includes a provenance column on every row.
            </p>
          )}
          <div className="modal-actions">
            <Button
              onClick={() => {
                setStatus("config");
                setResult(null);
                setBriefFile("");
              }}
            >
              Export another
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="export-result error" role="alert">
          <div className="file-row">
            <span className="file-glyph err">
              <Icon name="close" size={18} />
            </span>
            <div>
              <strong>The export did not complete</strong>
              <span>
                {error || "The browser could not generate the file."} Your filters and brief are
                preserved.
              </span>
            </div>
          </div>
          <div className="modal-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon="reset" onClick={() => setStatus("config")}>
              Try again
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

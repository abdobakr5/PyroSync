import {
  useEffect,
  useId,
  useState,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type ReactNode,
} from "react";

export function Icon({
  name,
  size = 19,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const paths: Record<string, ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    map: (
      <>
        <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z" />
        <path d="M9 3v15m6-12v15" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M7 3v4m10-4v4M3 11h18m-13 4h1m3 0h1m3 0h1m-9 3h1m3 0h1" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    anomaly: (
      <>
        <path d="M2 13h5l3-9 4 16 3-7h5" />
      </>
    ),
    seasonal: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
      </>
    ),
    regime: (
      <>
        <path d="M3 20h18M5 17V9m5 8V4m5 13v-6m5 6V6" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v7c0 4 18 4 18 0V5M3 12v7c0 4 18 4 18 0v-7" />
      </>
    ),
    book: (
      <>
        <path d="M12 5C9 2 5 3 2 4v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-7-2-10 1Zm0 0v16" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    down: <path d="m6 9 6 6 6-6" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    pin: (
      <>
        <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" />
        <circle cx="12" cy="10" r="2" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v1" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 8a3 3 0 0 1 6 1c0 2-3 2-3 4m0 3v1" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    target: (
      <>
        <circle cx="12" cy="12" r="7" />
        <circle cx="12" cy="12" r="2" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
      </>
    ),
    box: (
      <>
        <rect x="4" y="4" width="16" height="16" strokeDasharray="4 3" />
        <path d="M2 4h4M4 2v4m14 14h4m-2-2v4" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    fire: (
      <path d="M12 2c2 6-3 7-1 11 2-1 3-3 3-5 4 3 6 6 5 10-2 6-12 6-14 0-1-5 3-7 3-10 0 3 2 3 2 3-1-4 2-5 2-9Z" />
    ),
    satellite: (
      <>
        <path d="m10 7 7 7-4 4-7-7Zm-3 5-4 4 4 4 4-4m2-10 4-4 4 4-4 4M15 17l2 2m-5-7-3 3m9-3a7 7 0 0 1 4 6" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    back: <path d="M20 12H4m6-6-6 6 6 6" />,
    sort: (
      <>
        <path d="M8 4v16m-4-4 4 4 4-4m4-12v16m-4-12 4-4 4 4" />
      </>
    ),
    reset: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
      </>
    ),
    pause: <path d="M9 5v14M15 5v14" />,
    play: <path d="m8 5 11 7-11 7Z" />,
    grid: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L11 13M10 3H3v18h18v-7" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name] || paths.overview}
    </svg>
  );
}

export function Logo({
  compact = false,
  monochrome = false,
  light = false,
}: {
  compact?: boolean;
  monochrome?: boolean;
  light?: boolean;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const flame = monochrome ? "currentColor" : `url(#${id}f)`;
  return (
    <div className={`brand ${monochrome ? "monochrome" : ""} ${light ? "light" : ""}`}>
      <svg width="38" height="42" viewBox="0 0 40 44" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}f`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#087EBA" />
            <stop offset=".3" stopColor="#20BCE5" />
            <stop offset=".55" stopColor="#FFC15A" />
            <stop offset=".8" stopColor="#FF693B" />
            <stop offset="1" stopColor="#F04438" />
          </linearGradient>
        </defs>
        <path
          d="M20 3 35 12v20L20 41 5 32V12Z"
          stroke={monochrome ? "currentColor" : "var(--ice)"}
          strokeWidth="1.4"
          opacity=".7"
        />
        <path
          d="M21 7c3 8-6 9-3 16 3-1 5-5 5-7 7 7 6 14 0 17-7 3-14-2-12-9 1-3 4-5 4-8 1 2 2 3 2 3-1-5 4-7 4-12Z"
          fill={flame}
        />
        <path
          d="M1 29C7 35 32 18 39 14"
          stroke={monochrome ? "currentColor" : "var(--cyan)"}
          strokeWidth="1.4"
        />
        <path d="m20 27 4 2v5l-4 2-4-2v-5Z" fill="var(--logo-cutout, var(--bg))" />
      </svg>
      {!compact && (
        <span>
          PYRO<span className="brand-light">SYNC</span>
          <small>EARTH OBSERVATION INTELLIGENCE</small>
        </span>
      )}
    </div>
  );
}

/** Briefly tweens numeric KPI values when filters change (skipped for reduced motion). */
export function AnimatedNumber({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const a = from.current,
      b = value;
    if (a === b || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = b;
      setShown(b);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 420),
        v = a + (b - a) * (1 - (1 - k) ** 3);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <>
      {shown.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </>
  );
}

export function Button({
  children,
  variant = "secondary",
  icon,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  icon?: string;
}) {
  return (
    <button className={`button ${variant} ${className}`} {...props}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}
export function IconButton({
  icon,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      <Icon name={icon} />
    </button>
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className || ""}`} />;
}
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-wrap">
      <select {...props} className={`select ${props.className || ""}`}>
        {children}
      </select>
      <Icon name="down" size={14} />
    </span>
  );
}
export function Heading({
  children,
  level = 2,
  className = "",
}: {
  children: ReactNode;
  level?: 1 | 2 | 3;
  className?: string;
}) {
  const Tag = `h${level}` as "h1" | "h2" | "h3";
  return <Tag className={className}>{children}</Tag>;
}
export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Segment<T extends string>({
  value,
  options,
  onChange,
  className = "",
}: {
  value: T;
  options: { value: T; label: string; icon?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`segment ${className}`} role="group">
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={o.value === value}
          className={o.value === value ? "selected" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}
export function PanelHeader({
  title,
  eyebrow,
  children,
  icon,
}: {
  title: string;
  eyebrow?: string;
  children?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="panel-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <Heading level={2}>
          {icon && <Icon name={icon} size={18} />}
          {title}
        </Heading>
      </div>
      <div className="panel-actions">{children}</div>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  icon,
  description,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  icon?: ReactNode;
  description?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const els = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select,textarea,a[href],[tabindex="0"]',
        );
        if (!els?.length) return;
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = original;
      document.removeEventListener("keydown", key);
      old?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal ${wide ? "wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal-heading">
          {icon && <span className="modal-icon">{icon}</span>}
          <div className="modal-title">
            <Heading>{title}</Heading>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon="close" label="Close dialog" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}
export function Empty({
  title = "No observations in this selection",
  detail = "Try a wider date range, another region, or clear your active filters.",
  onReset,
}: {
  title?: string;
  detail?: string;
  onReset?: () => void;
}) {
  return (
    <div className="empty">
      <Icon name="search" size={30} />
      <Heading level={3}>{title}</Heading>
      <p>{detail}</p>
      {onReset && (
        <Button icon="reset" onClick={onReset}>
          Reset filters
        </Button>
      )}
    </div>
  );
}

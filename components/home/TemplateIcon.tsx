const S = { stroke: "#77746b", strokeWidth: 1.6, fill: "#2c2b28" };
const LINE = { stroke: "#77746b", strokeWidth: 2.2, strokeLinecap: "round" as const };
const ACC = "#d9774f";

function Page({ x = 18, y = 6, w = 34, h = 44 }: { x?: number; y?: number; w?: number; h?: number }) {
  return <path d={`M${x} ${y}h${w - 10}l10 10v${h - 10}h-${w}z`} {...S} strokeLinejoin="round" />;
}
function Lines({ x, y, widths, gap = 5, color }: { x: number; y: number; widths: number[]; gap?: number; color?: string }) {
  return (
    <>
      {widths.map((w, i) => (
        <path key={i} d={`M${x} ${y + i * gap}h${w}`} {...LINE} stroke={color ?? LINE.stroke} />
      ))}
    </>
  );
}

/** Line illustrations for the template grid, drawn to read at 64×56. */
export default function TemplateIcon({ id }: { id: string }) {
  const body = (() => {
    switch (id) {
      case "blank":
        return <Page x={17} y={4} w={30} h={46} />;
      case "mobile":
        return (
          <>
            <rect x="22" y="3" width="20" height="48" rx="5" {...S} />
            <rect x="26" y="9" width="12" height="8" rx="2" fill="#a9d8cf" />
            <Lines x={26.5} y={22} widths={[11, 8, 11]} />
            <rect x="26" y="37" width="12" height="5" rx="2.5" fill="#a9d8cf" />
          </>
        );
      case "slides":
        return (
          <>
            <rect x="8" y="12" width="36" height="24" rx="3" {...S} />
            <rect x="18" y="18" width="38" height="26" rx="3" {...S} fill="#34332f" />
            <Lines x={23} y={25} widths={[14, 10]} />
            <rect x="42" y="22" width="9" height="11" rx="1.5" fill="#8c8980" />
            <Lines x={23} y={37} widths={[20]} />
          </>
        );
      case "document":
        return (
          <>
            <Page x={16} y={4} w={32} h={46} />
            <Lines x={21} y={13} widths={[12, 20, 20, 16, 20, 20, 12]} />
          </>
        );
      case "wireframe":
        return (
          <>
            <rect x="10" y="8" width="44" height="38" rx="3" {...S} />
            <Lines x={15} y={14} widths={[12]} />
            <rect x="15" y="19" width="34" height="13" rx="1" fill="none" stroke="#77746b" strokeWidth={1.2} strokeDasharray="2 2" />
            <path d="M15 19l34 13M49 19 15 32" stroke="#77746b" strokeWidth={1} />
            <Lines x={15} y={38} widths={[16]} />
            <rect x="37" y="36" width="12" height="5" rx="2.5" fill="none" stroke="#77746b" strokeWidth={1.4} />
          </>
        );
      case "animation":
        return (
          <>
            <rect x="9" y="6" width="46" height="32" rx="3" {...S} />
            <circle cx="32" cy="22" r="7" fill="#77746b" />
            <path d="M30 18.5v7l6-3.5z" fill="#2c2b28" />
            <path d="M9 47h46" stroke="#77746b" strokeWidth={3} strokeLinecap="round" />
            <path d="M9 47h16" stroke="#c9c6bc" strokeWidth={3} strokeLinecap="round" />
            <circle cx="26" cy="47" r="3.2" fill="#e9e7e0" />
          </>
        );
      case "ui":
        return (
          <>
            <rect x="12" y="8" width="38" height="30" rx="3" {...S} />
            <rect x="18" y="16" width="38" height="30" rx="3" {...S} fill="#34332f" />
            <rect x="18" y="16" width="8" height="30" rx="2" fill="#2c2b28" />
            <rect x="30" y="22" width="16" height="7" rx="2" fill="#a9d8cf" />
            <Lines x={31} y={33} widths={[14]} />
            <rect x="30" y="37" width="12" height="4" rx="2" fill={ACC} />
          </>
        );
      case "resume":
        return (
          <>
            <Page x={16} y={4} w={32} h={46} />
            <rect x="21" y="10" width="8" height="8" rx="1.5" fill="#8c8980" />
            <Lines x={32} y={12} widths={[8]} color={ACC} />
            <Lines x={21} y={24} widths={[18, 12]} color={ACC} />
            <Lines x={21} y={34} widths={[20, 16, 20]} />
          </>
        );
      case "3d":
        return (
          <>
            <path d="M32 6 50 16 32 26 14 16z" fill="#d6d3cb" />
            <path d="M14 16 32 26v22L14 38z" fill="#8c8980" />
            <path d="M50 16 32 26v22l18-10z" fill="#5e5c56" />
            <ellipse cx="32" cy="51" rx="16" ry="2.5" fill="#1a1918" />
          </>
        );
      case "landing":
        return (
          <>
            <rect x="8" y="6" width="48" height="42" rx="3" {...S} />
            <Lines x={13} y={12} widths={[6]} />
            <path d="M42 12h9" {...LINE} />
            <Lines x={13} y={21} widths={[24, 16]} gap={6} color="#e9e7e0" />
            <rect x="13" y="32" width="12" height="5" rx="2.5" fill={ACC} />
            <rect x="36" y="20" width="15" height="17" rx="2" fill="#a9d8cf" />
          </>
        );
      case "cinematic":
        return (
          <>
            <rect x="8" y="6" width="48" height="42" rx="3" {...S} />
            <path d="M8 15h48M8 39h48" stroke="#1a1918" strokeWidth={5} />
            <rect x="12" y="17" width="7" height="4" rx="1" fill="#1a1918" />
            <rect x="22" y="17" width="7" height="4" rx="1" fill="#1a1918" />
            <rect x="32" y="17" width="7" height="4" rx="1" fill="#1a1918" />
            <rect x="42" y="17" width="7" height="4" rx="1" fill="#1a1918" />
            <circle cx="26" cy="27" r="10" fill="#d6a17a" />
            <circle cx="38" cy="30" r="6" fill="#5e5c56" />
            <path d="M8 46q10-7 20-3t28-4" fill="none" stroke={ACC} strokeWidth={2} strokeLinecap="round" />
          </>
        );
      case "designsystem":
        return (
          <>
            <rect x="8" y="6" width="48" height="42" rx="4" {...S} />
            <rect x="13" y="11" width="7" height="7" rx="1.5" fill={ACC} />
            <rect x="22" y="11" width="7" height="7" rx="1.5" fill="#a9d8cf" />
            <rect x="31" y="11" width="7" height="7" rx="1.5" fill="#d6d3cb" />
            <rect x="40" y="11" width="7" height="7" rx="1.5" fill="#5e5c56" />
            <text x="13" y="33" fontFamily="Georgia, serif" fontSize="12" fill="#e9e7e0">
              Aa
            </text>
            <rect x="32" y="25" width="17" height="6" rx="3" fill={ACC} />
            <rect x="32" y="34" width="17" height="6" rx="3" fill="none" stroke="#77746b" strokeWidth={1.4} />
            <Lines x={13} y={42} widths={[12]} />
          </>
        );
      case "research":
        return (
          <>
            <Page x={14} y={4} w={32} h={46} />
            <Lines x={19} y={13} widths={[12, 20, 14, 20]} />
            <circle cx="40" cy="36" r="7" fill="#2c2b28" stroke="#e9e7e0" strokeWidth={2.2} />
            <path d="m45 41 6 6" stroke="#e9e7e0" strokeWidth={3} strokeLinecap="round" />
          </>
        );
      case "email":
        return (
          <>
            <rect x="12" y="6" width="40" height="42" rx="3" {...S} />
            <circle cx="18.5" cy="12.5" r="2" fill="#c9c6bc" />
            <Lines x={23} y={12.5} widths={[10]} />
            <Lines x={18} y={22} widths={[26, 20, 26]} />
            <rect x="21" y="37" width="22" height="5" rx="2.5" fill={ACC} />
          </>
        );
      case "palette":
        return (
          <>
            <rect x="9" y="6" width="46" height="42" rx="4" {...S} />
            <text x="15" y="25" fontFamily="Georgia, serif" fontSize="15" fill="#e9e7e0">
              Aa
            </text>
            <path d="M36 14h12M36 19h8" {...LINE} />
            <rect x="15" y="33" width="8" height="8" rx="1.5" fill={ACC} />
            <rect x="26" y="33" width="8" height="8" rx="1.5" fill="#d6d3cb" />
            <rect x="37" y="33" width="8" height="8" rx="1.5" fill="#a9d8cf" />
          </>
        );
      default:
        return <Page />;
    }
  })();
  return (
    <svg width="64" height="56" viewBox="0 0 64 56" aria-hidden="true">
      {body}
    </svg>
  );
}

interface Props {
  crumbs: Array<{ label: string; scope: string }>
  onNavigate: (scope: string) => void
}

export function Breadcrumbs({ crumbs, onNavigate }: Props) {
  return (
    <nav className="breadcrumbs" aria-label="Diagram scope">
      {crumbs.map((crumb, i) => (
        <span key={crumb.scope || 'root'}>
          {i > 0 ? <span className="crumb-sep">/</span> : null}
          <button
            className={i === crumbs.length - 1 ? 'crumb current' : 'crumb'}
            onClick={() => onNavigate(crumb.scope)}
            disabled={i === crumbs.length - 1}
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </nav>
  )
}

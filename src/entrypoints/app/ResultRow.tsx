import { isOpenable, isWebUrl } from '@/core/canonical';
import type { Hit } from '@/core/search/lexical';
import { SOURCE_LABELS, type Item } from '@/core/types';
import { absoluteDate, displayUrl, faviconUrl, relativeTime } from './format';

interface Props {
  hit: Hit;
  selected: boolean;
  onHover: () => void;
  onOpen: (item: Item, background?: boolean) => void;
}

export function ResultRow({ hit, selected, onHover, onOpen }: Props) {
  const { item } = hit;
  const openable = isOpenable(item.url);
  const removedFrom = [...new Set(item.saveRefs.filter((r) => r.removed).map((r) => r.source))].filter(
    (s) => !item.sources.includes(s),
  );

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Web links open natively (so middle/Cmd-click work); chrome:// and file:// need the tabs API.
    if (isWebUrl(item.url)) return;
    e.preventDefault();
    if (openable) onOpen(item, e.metaKey || e.ctrlKey);
  };

  return (
    <li className={`row${item.removed ? ' removed' : ''}`} aria-selected={selected} onMouseMove={onHover}>
      <img className="favicon" src={faviconUrl(item.url)} alt="" width={16} height={16} loading="lazy" />
      <div className="row-body">
        <a className="title" href={openable ? item.url : undefined} target="_blank" rel="noopener noreferrer"
          onClick={onClick}>
          {item.title}
        </a>
        <div className="url">{displayUrl(item.url)}</div>
        <div className="meta">
          {item.sources.map((s) => (
            <span key={s} className={`badge badge-${s}`}>{SOURCE_LABELS[s]}</span>
          ))}
          {removedFrom.map((s) => (
            <span key={s} className="badge badge-removed">Removed from {SOURCE_LABELS[s]}</span>
          ))}
          {item.folderPaths.slice(0, 2).map((f) => (
            <span key={f} className="folder" title={f}>{f}</span>
          ))}
          <span className="date" title={`Saved ${absoluteDate(item.lastSavedAt)}`}>
            {relativeTime(item.lastSavedAt)}
          </span>
        </div>
      </div>
    </li>
  );
}

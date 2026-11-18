import { JSX, Show } from 'solid-js';
import { Icon, IconName } from '../lib/icons';

export function EmptyState(p: { icon: IconName; title: string; detail?: string; children?: JSX.Element }) {
  return (
    <div class="empty">
      <div class="empty-icon"><Icon name={p.icon} size={28} /></div>
      <div class="empty-title">{p.title}</div>
      <Show when={p.detail}><div class="empty-detail">{p.detail}</div></Show>
      {p.children}
    </div>
  );
}

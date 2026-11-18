import { runCommand, tip } from '../commands/registry';
import { Icon, IconName } from '../lib/icons';
import { settings } from '../state/settings';
import { activeTab, currentDir } from '../state/tabs';
import { MenuItem, openMenuAt } from '../state/ui';
import { newMenu, sortMenu, viewMenu } from './menus';
import { CmdButton } from './NavRow';

function MenuButton(p: { label: string; icon: IconName; items: () => MenuItem[]; disabled?: boolean; tip?: string }) {
  return (
    <button class="btn btn-text btn-menu" disabled={p.disabled} data-tip={p.tip}
      onClick={(e) => { const el = e.currentTarget; if (openMenuAt(el, p.items(), () => el.classList.remove('open'))) el.classList.add('open'); }}>
      <Icon name={p.icon} /><span>{p.label}</span><Icon name="chevronDown" size={12} class="ic caret" />
    </button>
  );
}

export function CommandBar() {
  const t = activeTab;
  const more = (): MenuItem[] => [
    { cmd: 'edit.selectAll' }, { cmd: 'edit.selectNone' }, { cmd: 'edit.invert' },
    { sep: true },
    { cmd: 'edit.copyPath' }, { cmd: 'file.moveTo' }, { cmd: 'file.copyTo' }, { cmd: 'file.pin' },
    { sep: true },
    { cmd: 'shell.terminal' }, { cmd: 'item.properties' },
    { sep: true },
    { cmd: 'palette.open', label: 'Command palette', icon: 'bolt' },
    { cmd: 'app.settings' },
  ];
  const viewIcon = (): IconName => ({ details: 'details', list: 'list', grid: 'grid' } as const)[t().view().view];
  return (
    <div class="cmdbar">
      <MenuButton label="New" icon="plus" items={newMenu} disabled={!currentDir() || !!t().search()} tip="Create a new folder or file" />
      <span class="vsep" />
      <CmdButton cmd="edit.cut" />
      <CmdButton cmd="edit.copy" />
      <CmdButton cmd="edit.paste" />
      <CmdButton cmd="edit.rename" />
      <CmdButton cmd="edit.delete" />
      <span class="vsep" />
      <MenuButton label="Sort" icon="sort" items={() => sortMenu(t())} disabled={t().loc().kind === 'home' && !t().search()} />
      <MenuButton label="View" icon={viewIcon()} items={() => viewMenu(t())} />
      <span class="vsep" />
      <button class="btn btn-icon" data-tip="More options" aria-label="More options"
        onClick={(e) => { const el = e.currentTarget; if (openMenuAt(el, more(), () => el.classList.remove('open'))) el.classList.add('open'); }}>
        <Icon name="more" />
      </button>
      <span class="flex" />
      <button class="btn btn-text" classList={{ on: settings.previewPane }} data-tip={tip('view.previewPane')} aria-pressed={settings.previewPane}
        onClick={() => runCommand('view.previewPane')}>
        <Icon name="preview" /><span>Preview</span>
      </button>
    </div>
  );
}

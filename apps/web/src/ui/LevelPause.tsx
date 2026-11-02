// Pause of the automatic gain asked by the DJ (scratching, a microphone, a live act): a button; while
// it lasts, the time left (unless the screen shows it elsewhere) and a button to resume at once.
// Afterwards the automatic gain listens again for a few seconds before it corrects anything.

import { LEVELER_PAUSE_MIN, type LevelerState } from '@dsp-studio/protocol';
import type { DeviceMirror } from '../client/mirror.ts';
import { fmtCountdown, levelerRequest } from '../state/leveler.ts';
import { Button } from './kit.tsx';
import { t } from '../i18n.tsx';
import './level.css';

export function LevelPause({ mirror, st, countdown = true }: { mirror: DeviceMirror; st: LevelerState; countdown?: boolean }): React.JSX.Element | null {
  if (!st.settings.enabled || st.status === 'offline') return null;
  if (st.pause > 0) {
    return (
      <div className="lv-pause">
        {countdown && <span className="lv-pause-left" role="timer">{t('En pause, reprise dans {0}', fmtCountdown(st.pause))}</span>}
        <Button kind="primary" icon="play" onClick={() => { void levelerRequest(mirror, 'pause', 0); }}>{t('Reprendre maintenant')}</Button>
      </div>
    );
  }
  return (
    <div className="lv-pause">
      <Button icon="pause" onClick={() => { void levelerRequest(mirror, 'pause', LEVELER_PAUSE_MIN); }}>{t('Pause {0} min', LEVELER_PAUSE_MIN)}</Button>
    </div>
  );
}

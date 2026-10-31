import { useAtomValue } from 'jotai';

import { openInspector } from '@/infra/atoms/inspector-atoms';
import { inspectorEnabledAtom, setInspectorEnabled } from '@/infra/atoms/settings-atoms';
import { CHECKBOX, SECTION_TITLE } from '@/shared-components/user-modal/parts';

/**
 * The rest of this browser's settings: the ones for looking under the hood. The messages
 * inspector (docs/status.md): the frames this browser gets, in the browser. A shared worker's
 * socket does not show in a tab's devtools, and a phone has no devtools.
 */
export function AdvancedTab() {
  const inspectorOn = useAtomValue(inspectorEnabledAtom);
  return (
    <div className="divide-y divide-primaryStroke">
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>debugging</legend>
        <p className="mt-1 text-textSecondary">the messages the pages send and get: the events socket, the chat, the video setup. the last 1000, with a filter.</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-base">
            <input id="inspector" type="checkbox" checked={inspectorOn} onChange={(e) => setInspectorEnabled(e.target.checked)} className={CHECKBOX} />
            keep the messages
          </label>
          {inspectorOn && (
            <button id="inspector-open-settings" type="button" className="text-base font-semibold text-primaryBlue" onClick={openInspector}>
              open messages
            </button>
          )}
        </div>
        <p className="mt-4 text-sm text-textTertiary">
          off, nothing is kept. on, a button sits beside the gear in the corner panel. tokens are taken out before anything is kept; nothing leaves the browser.
        </p>
      </fieldset>
    </div>
  );
}

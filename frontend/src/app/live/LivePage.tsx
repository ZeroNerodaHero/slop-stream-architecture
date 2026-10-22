import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  avatarStatusAtom,
  bioDraftAtom,
  bioStatusAtom,
  cameraAtom,
  canStartAtom,
  chatRoomAtom,
  commitStreamName,
  copyWatchUrl,
  enterLivePage,
  goLive,
  isPublishingAtom,
  leaveLivePage,
  myAvatarAtom,
  ownerAtom,
  publishMessageAtom,
  publishToneAtom,
  removeAvatar,
  saveAvatar,
  saveBio,
  setStreamName,
  startCamera,
  stopLive,
  stopOnLeave,
  streamNameAtom,
  watchUrlAtom
} from '@/infra/atoms/publish-atoms';
import { store } from '@/infra/store';
import { Avatar } from '@/shared-components/Avatar';
import { Button } from '@/shared-components/Button';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { PageFrame } from '@/shared-components/PageFrame';
import { panelClassName } from '@/shared-components/Panel';
import { StatusLine } from '@/shared-components/StatusLine';
import { VideoFrame } from '@/shared-components/VideoFrame';

export function LivePage() {
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const message = useAtomValue(publishMessageAtom);
  const tone = useAtomValue(publishToneAtom);
  const name = useAtomValue(streamNameAtom);
  const chatRoom = useAtomValue(chatRoomAtom);
  const canStart = useAtomValue(canStartAtom);
  const publishing = useAtomValue(isPublishingAtom);
  const watchUrl = useAtomValue(watchUrlAtom);
  const bioDraft = useAtomValue(bioDraftAtom);
  const bioStatus = useAtomValue(bioStatusAtom);
  const avatar = useAtomValue(myAvatarAtom);
  const avatarStatus = useAtomValue(avatarStatusAtom);
  const owner = useAtomValue(ownerAtom);
  const me = useAtomValue(meAtom);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Mount only: open the camera, fill the name box, end the stream when the tab or the page goes away.
  useEffect(() => {
    void startCamera();
    void enterLivePage();
    addEventListener('pagehide', stopOnLeave);
    addEventListener('beforeunload', stopOnLeave);
    return () => {
      removeEventListener('pagehide', stopOnLeave);
      removeEventListener('beforeunload', stopOnLeave);
      leaveLivePage();
    };
  }, []);

  return (
    <PageFrame title="go live" aside={<Link to="/">home</Link>} wide>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
        <div className="min-w-0">
          <VideoFrame id="preview" streamAtom={cameraAtom} videoRef={previewRef} muted />
          <StatusLine text={message} tone={tone} />

          <div className="my-3 flex flex-wrap items-center gap-3">
            <label htmlFor="name" className="sr-only">
              your name
            </label>
            <input
              id="name"
              value={name}
              onChange={(e) => setStreamName(e.target.value)}
              onBlur={() => void commitStreamName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              disabled={publishing || !!me}
              title={me ? 'you stream as your account' : undefined}
              placeholder="your name"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={32}
              className="w-full max-w-[320px] border border-primaryStroke bg-backgroundSecondary px-4 py-3 text-textPrimary disabled:opacity-60"
            />
            {!publishing && (
              <Button id="start" variant="primary" disabled={!canStart} onClick={() => void goLive()}>
                start
              </Button>
            )}
            {publishing && (
              <Button id="stop" variant="danger" onClick={() => stopLive()}>
                stop
              </Button>
            )}
          </div>

          {watchUrl && (
            <p id="link" className="my-3 [overflow-wrap:anywhere]">
              watch link:{' '}
              <a id="watchurl" href={watchUrl} target="_blank" rel="noopener">
                {watchUrl}
              </a>{' '}
              <Button id="copy" className="ml-2 px-4 py-2" onClick={copyWatchUrl}>
                copy
              </Button>
            </p>
          )}

          <section className={panelClassName('my-5 px-5 py-4')}>
            <label htmlFor="bio" className="text-textSecondary">
              your bio
            </label>
            <textarea
              id="bio"
              value={bioDraft}
              onChange={(e) => store.set(bioDraftAtom, e.target.value)}
              placeholder="who are you. what is this stream."
              maxLength={500}
              className="mt-2 min-h-[90px] w-full resize-y border border-primaryStroke bg-background px-4 py-3 text-textPrimary"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button id="savebio" onClick={() => void saveBio()}>
                save bio
              </Button>
              <span id="biostatus" className="text-textSecondary" aria-live="polite">
                {bioStatus}
              </span>
            </div>

            {/* the picture: on the watch page next to your name, and in the preview card of a shared link */}
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-primaryStroke pt-4">
              <Avatar name={name} version={avatar} className="mr-0 h-16 w-16" />
              <span className="text-textSecondary">your picture</span>
              <input
                ref={fileRef}
                id="avatar-file"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void saveAvatar(file);
                }}
              />
              <Button id="avatar-pick" onClick={() => fileRef.current?.click()}>
                {avatar === null ? 'choose picture' : 'change picture'}
              </Button>
              {avatar !== null && (
                <Button id="avatar-remove" onClick={() => void removeAvatar()}>
                  remove
                </Button>
              )}
              <span id="avatarstatus" className="text-textSecondary" aria-live="polite">
                {avatarStatus}
              </span>
            </div>
          </section>
        </div>

        {/* the streamer's own chat, in the room of the settled name. once live, `owner` makes its lines marked */}
        {chatRoom ? (
          <ChatPanel name={chatRoom} owner={owner} className="mt-4 h-[60vh] max-h-[640px] lg:mt-0 lg:h-[calc(100vh-140px)] lg:max-h-[720px]" />
        ) : (
          <aside
            id="chat"
            className="mt-4 flex min-h-[200px] items-center justify-center border border-dashed border-secondaryStroke p-6 text-center text-textTertiary lg:mt-0 lg:h-[calc(100vh-140px)] lg:max-h-[720px]"
          >
            type your name and the chat opens here. once you are live, your lines are marked.
          </aside>
        )}
      </div>
    </PageFrame>
  );
}

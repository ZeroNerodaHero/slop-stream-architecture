import { RiArrowRightLine, RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { dummyPage } from '@/infra/about';
import { api } from '@/infra/api';
import { homeStreamsAtom } from '@/infra/atoms/home-atoms';
import { showSpeaker } from '@/infra/atoms/chat-atoms';
import { openDm } from '@/infra/atoms/dm-atoms';
import { followingAtom, loadPeek, peeksAtom } from '@/infra/atoms/follow-atoms';
import { presencesAtom } from '@/infra/atoms/presence-atoms';
import { myNameAtom } from '@/infra/atoms/profile-atoms';
import { closeProfilePopup, profilePopupAtom, type ProfilePopupTarget } from '@/infra/atoms/profile-popup-atoms';
import { holdPresence, onEvents, releasePresence, wantsPresence } from '@/infra/events';
import { useIsMobile } from '@/infra/mobile';
import { isDummyName } from '@/infra/names';
import { previewStreamsAtom, setPopupPreview } from '@/infra/preview';
import { cleanSocials } from '@/infra/socials';
import { store } from '@/infra/store';
import { About } from '@/shared-components/About';
import { Badge } from '@/shared-components/Badge';
import { BlurredPicture } from '@/shared-components/BlurredPicture';
import { buttonClassName } from '@/shared-components/Button';
import { Calendar } from '@/shared-components/Calendar';
import { Face } from '@/shared-components/Face';
import { FollowButton } from '@/shared-components/FollowButton';
import { SHEET_CLOSE, SHEET_DIALOG, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { OfflinePicture } from '@/shared-components/OfflinePicture';
import { Who, Word } from '@/shared-components/PersonRow';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { Socials } from '@/shared-components/Socials';
import { StreamStill } from '@/shared-components/StreamStill';
import { Tooltip } from '@/shared-components/Tooltip';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { useHeardUid, VoiceLevel } from '@/shared-components/VoiceLevel';
import { cn } from '@/utils/cn';
import { monthOf } from '@/utils/since';
import { roveTabs } from '@/utils/tabs';

type PopupTab = 'about' | 'calendar' | 'socials';
const POPUP_TABS: readonly PopupTab[] = ['about', 'calendar', 'socials'];
const TAB = '-mb-px border-b-2 px-3 py-1.5 font-semibold leading-tight transition-colors duration-150';
const TAB_ON = 'border-primaryBlue bg-backgroundTertiary text-textPrimary';
const TAB_OFF = 'border-transparent text-textSecondary hover:bg-backgroundTertiary/60 hover:text-textPrimary';
const WORDS = 'text-sm font-semibold text-primaryBlue underline-offset-2 hover:underline';
const SMALL = 'px-3 py-1.5 text-sm max-md:min-h-11';

export function ProfilePopup() {
  const target = useAtomValue(profilePopupAtom);
  return target ? <ProfileDialog key={target.name} target={target} /> : null;
}

function LiveStream({ name, onGo, backdrop }: { name: string; onGo: () => void; backdrop: ReactNode }) {
  const stream = useAtomValue(previewStreamsAtom)[name] ?? null;
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playingStream, setPlayingStream] = useState<MediaStream | null>(null);
  const playing = stream !== null && playingStream === stream;

  useEffect(() => {
    setPopupPreview(name);
    return () => setPopupPreview(null);
  }, [name]);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
  }, [stream]);

  return (
    <Link
      id="profile-popup-stream"
      to={`/watch/${encodeURIComponent(name)}`}
      state={{ live: true }}
      onClick={onGo}
      draggable={false}
      aria-label={`watch ${name}`}
      className="relative block border border-primaryStroke outline-none transition-[border-color] duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue"
    >
      {backdrop}
      <StreamStill name={name} className={cn('w-full border-0', backdrop !== null && 'bg-transparent')} />
      <video
        ref={ref}
        data-preview={name}
        autoPlay
        playsInline
        muted
        aria-hidden
        onPlaying={() => setPlayingStream(stream)}
        className={cn('absolute inset-0 h-full w-full object-cover', !playing && 'opacity-0')}
      />
      <span className="absolute left-3 top-3 flex items-center gap-1.5 border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
        <span aria-hidden className="h-2 w-2 animate-pulse bg-increase motion-reduce:animate-none" />
        live
      </span>
    </Link>
  );
}

function ProfileDialog({ target }: { target: ProfilePopupTarget }) {
  const { name } = target;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const pressedBackdrop = useRef(false);
  const { pathname } = useLocation();
  const [openedOn] = useState(pathname);
  const [tab, setTab] = useState<PopupTab>('about');
  const [failed, setFailed] = useState(false);
  const card = useAtomValue(peeksAtom)[name]?.card;
  const heard = useAtomValue(presencesAtom).get(name);
  const [trusted, setTrusted] = useState(() => wantsPresence(name));
  const friend = useAtomValue(followingAtom)?.find((f) => f.name === name && f.mutual);
  const mine = useAtomValue(myNameAtom) === name;
  const viewers = useAtomValue(homeStreamsAtom)?.find((s) => s.name === name)?.viewers ?? null;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    if (failed) return;
    let gone = false;
    void loadPeek(name).then(() => {
      if (!gone && !store.get(peeksAtom)[name]) setFailed(true);
    });
    return () => {
      gone = true;
    };
  }, [name, failed]);

  useEffect(() => {
    holdPresence(name);
    const off = onEvents((event) => {
      if (event.type === 'presence' && event.name === name) setTrusted(true);
    });
    return () => {
      off();
      releasePresence(name);
    };
  }, [name]);

  useEffect(() => {
    if (pathname !== openedOn) closeProfilePopup();
  }, [pathname, openedOn]);

  const close = () => dialogRef.current?.close();
  useSheetBack(close);
  const mobile = useIsMobile();
  const heardUid = useHeardUid(name);

  const presence = (trusted ? heard : undefined) ?? card?.presence;
  const live = presence === 'streaming';
  const verified = card?.verified ?? target.verified;
  const oauthVerified = card?.oauth_verified ?? target.oauth_verified;
  const avatar = card ? card.avatar : target.avatar;
  const offline = card?.offline ?? null;
  const thumb = card?.thumbs?.[0] !== undefined ? api.streamThumbUrl(name, card.thumbs[0]) : null;
  const backdrop = thumb !== null || avatar !== null ? <BlurredPicture name={name} version={avatar} src={thumb} /> : null;
  const picture = live || offline !== null || backdrop !== null;
  const socials = useMemo(() => cleanSocials(card?.socials), [card?.socials]);
  const about = useMemo(() => (isDummyName(name) ? dummyPage(name, { offline }) : null), [name, offline]);
  const page = `/watch/${encodeURIComponent(name)}`;

  return (
    <dialog
      ref={dialogRef}
      id="profile-popup"
      data-name={name}
      data-presence={presence}
      data-sheet={mobile ? '' : undefined}
      aria-labelledby="profile-popup-title"
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) close();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        closeProfilePopup();
      }}
      className={cn(
        'overflow-hidden bg-backgroundSecondary p-0 text-base text-textPrimary',
        'open:flex flex-col',
        'm-0 max-h-none w-full max-w-none border border-primaryStroke',
        SHEET_DIALOG,
        'md:mx-auto md:mb-auto md:mt-[8dvh] md:h-fit md:max-h-[calc(92dvh-1.5rem)] md:min-h-[min(22rem,calc(92dvh-1.5rem))] md:w-[min(720px,calc(100vw-3rem))]',
        'backdrop:bg-black/60 md:backdrop:backdrop-blur-sm'
      )}
    >
      <SheetGrab onDismiss={close} />
      <header className="flex shrink-0 items-start gap-4 px-5 pt-5 max-md:pt-0">
        <Face name={name} version={avatar} className="h-14 w-14 text-2xl" />
        <div className="min-w-0 flex-1">
          <h2 id="profile-popup-title" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xl leading-tight">
            <Who name={name} verified={verified} oauthVerified={oauthVerified} />
            {presence && <Word presence={presence} className="font-normal" />}
          </h2>
          <div id="profile-popup-meta" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-textSecondary">
            {card?.badge && <Badge group={card.badge} className="min-w-0" />}
            {typeof card?.followers === 'number' && !isDummyName(name) && (
              <span id="profile-popup-followers">
                {card.followers} {card.followers === 1 ? 'follower' : 'followers'}
              </span>
            )}
            {live && <ViewerCount id="profile-popup-viewers" count={viewers} className="shrink-0 whitespace-nowrap text-textSecondary" />}
          </div>
          {card?.bio && (
            <p id="profile-popup-bio" title={card.bio} className="mt-1 line-clamp-3 text-textSecondary [overflow-wrap:anywhere]">
              {card.bio}
            </p>
          )}
        </div>
        <Tooltip content="close" at="left">
          <button
            ref={closeRef}
            id="profile-popup-close"
            type="button"
            aria-label="close"
            aria-keyshortcuts="Escape"
            onClick={close}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue',
              SHEET_CLOSE
            )}
          >
            <RiCloseLine aria-hidden size={20} />
          </button>
        </Tooltip>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-primaryStroke px-5 py-3 max-md:grid max-md:auto-cols-fr max-md:grid-flow-col max-md:items-stretch max-md:gap-x-2">
        {!isDummyName(name) && <FollowButton id="profile-popup-follow" name={name} className="max-md:min-h-11" />}
        {friend && (
          <button
            id="profile-popup-message"
            type="button"
            className={buttonClassName('secondary', SMALL)}
            onClick={() => {
              openDm({ id: '', name, avatar: friend.avatar, verified: friend.verified, bio: friend.bio, presence: friend.presence });
              close();
            }}
          >
            message
          </button>
        )}
        {target.lines && !mobile && (
          <Tooltip content="show only their messages in this chat">
            <button
              id="profile-popup-lines"
              type="button"
              className={buttonClassName('secondary', SMALL)}
              onClick={() => {
                if (target.lines) void showSpeaker(name, target.lines);
                close();
              }}
            >
              their messages
            </button>
          </Tooltip>
        )}
        {openedOn !== page && (
          <Link
            id="profile-popup-page"
            to={page}
            state={live ? { live: true } : undefined}
            onClick={close}
            draggable={false}
            className={buttonClassName('secondary', cn('ml-auto gap-1.5 max-md:ml-0 max-md:px-2 max-md:leading-tight', SMALL))}
          >
            {mine ? 'go to your page' : 'go to their page'}
            <RiArrowRightLine aria-hidden size={16} />
          </Link>
        )}
      </div>

      {mobile && heardUid && <VoiceLevel id="profile-popup-voice" name={name} uid={heardUid} className="shrink-0 border-b border-t-0 px-5 py-3" />}

      <div id="profile-popup-body" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
        {failed ? (
          <p id="profile-popup-failed" className="text-textSecondary">
            could not load {name}.{' '}
            <button type="button" className={WORDS} onClick={() => setFailed(false)}>
              try again
            </button>
          </p>
        ) : !card ? (
          <Skeleton id="profile-popup-loading" label={`loading ${name}`} className="flex flex-col gap-3">
            <Bone className="h-9 w-64 max-w-full" />
            <Bone className="h-4 w-3/4" />
            <Bone className="h-4 w-1/2" />
          </Skeleton>
        ) : (
          <>
            {live ? (
              <LiveStream name={name} onGo={close} backdrop={backdrop} />
            ) : offline !== null ? (
              <OfflinePicture id="profile-popup-offline" src={api.offlineUrl(name, offline)} className="w-full" />
            ) : (
              backdrop !== null && (
                <span id="profile-popup-backdrop" className="relative block aspect-video w-full overflow-hidden border border-primaryStroke bg-black">
                  {backdrop}
                </span>
              )
            )}
            {!live && card.offline_note && (
              <p id="profile-popup-offline-note" className={cn('[overflow-wrap:anywhere]', picture && 'mt-3')}>
                {card.offline_note}
              </p>
            )}

            <div id="profile-popup-tabs" className={cn((picture || card.offline_note) && 'mt-5')}>
              <div role="tablist" aria-label="about them" onKeyDown={roveTabs} className="flex gap-1 border-b border-primaryStroke">
                {POPUP_TABS.map((t) => {
                  const on = t === tab;
                  return (
                    <button
                      key={t}
                      id={`profile-popup-tab-${t}`}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      aria-controls={on ? `profile-popup-panel-${t}` : undefined}
                      tabIndex={on ? 0 : -1}
                      onClick={() => setTab(t)}
                      className={cn(TAB, on ? TAB_ON : TAB_OFF)}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              <div id={`profile-popup-panel-${tab}`} role="tabpanel" aria-labelledby={`profile-popup-tab-${tab}`} className="pt-4">
                {tab === 'about' ? (
                  <About key={name} name={name} doc={about} id="profile-popup-about" />
                ) : tab === 'calendar' ? (
                  <Calendar name={name} scope="popup" live={live} id="profile-popup-calendar" />
                ) : (
                  <div className="flex flex-col gap-3">
                    {card.joined_at && (
                      <p id="profile-popup-joined" className="text-sm text-textSecondary">
                        joined{' '}
                        <time dateTime={card.joined_at} title={new Date(card.joined_at).toLocaleDateString()}>
                          {monthOf(card.joined_at)}
                        </time>
                      </p>
                    )}
                    <Socials id="profile-popup-socials" name={name} doc={socials} />
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

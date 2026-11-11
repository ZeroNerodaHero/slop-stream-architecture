import { RiArrowRightLine, RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { dummyPage } from '@/infra/about';
import { api } from '@/infra/api';
import { showSpeaker } from '@/infra/atoms/chat-atoms';
import { openDm } from '@/infra/atoms/dm-atoms';
import { followingAtom, loadPeek, peeksAtom } from '@/infra/atoms/follow-atoms';
import { presencesAtom } from '@/infra/atoms/presence-atoms';
import { myNameAtom } from '@/infra/atoms/profile-atoms';
import { closeProfilePopup, profilePopupAtom, type ProfilePopupTarget } from '@/infra/atoms/profile-popup-atoms';
import { holdPresence, onEvents, releasePresence, wantsPresence } from '@/infra/events';
import { isDummyName } from '@/infra/names';
import { previewStreamsAtom, setPopupPreview } from '@/infra/preview';
import { cleanSocials } from '@/infra/socials';
import { store } from '@/infra/store';
import { About } from '@/shared-components/About';
import { buttonClassName } from '@/shared-components/Button';
import { Calendar } from '@/shared-components/Calendar';
import { Face } from '@/shared-components/Face';
import { FollowButton } from '@/shared-components/FollowButton';
import { Who, Word } from '@/shared-components/PersonRow';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { Socials } from '@/shared-components/Socials';
import { StreamStill } from '@/shared-components/StreamStill';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';
import { monthOf } from '@/utils/since';
import { roveTabs } from '@/utils/tabs';

/** Their page's three tabs (WatchPage.tsx), in its order. */
type PopupTab = 'about' | 'calendar' | 'socials';
const POPUP_TABS: readonly PopupTab[] = ['about', 'calendar', 'socials'];
/** A tab, the watch page's look: the open one wears the blue line under it. */
const TAB = '-mb-px border-b-2 px-3 py-1.5 font-semibold leading-tight transition-colors duration-150';
const TAB_ON = 'border-primaryBlue bg-backgroundTertiary text-textPrimary';
const TAB_OFF = 'border-transparent text-textSecondary hover:bg-backgroundTertiary/60 hover:text-textPrimary';
/** A small action beside the buttons: words alone (buttons.mdc). */
const WORDS = 'text-sm font-semibold text-primaryBlue underline-offset-2 hover:underline';

/**
 * The profile popup (docs/follows.md): somebody's page over the page you are on, discord's
 * way. A click on a member of a group's roster, or on a name in a chat, opens it while this
 * browser's setting says so (settings.profilePopup, the chat tab's `people` cards: on unless
 * turned off, and then the click does what it did before). Mounted by the Shell; it renders
 * nothing until `openProfilePopup`.
 */
export function ProfilePopup() {
  const target = useAtomValue(profilePopupAtom);
  // keyed on the name: another person is another popup, read fresh
  return target ? <ProfileDialog key={target.name} target={target} /> : null;
}

/**
 * Their stream while they are live, the width of the popup: video's frame of it
 * (StreamStill.tsx) until their camera is playing, then the camera, muted (infra/preview.ts:
 * a peer of its own beside whatever the page plays, and not a viewer). The whole picture is
 * the way to their page, where the stream has its sound and its chat. Wanted while it is on
 * screen: the popup closing, or the stream ending, hangs it up.
 */
function LiveStream({ name, onGo }: { name: string; onGo: () => void }) {
  const stream = useAtomValue(previewStreamsAtom)[name] ?? null;
  const ref = useRef<HTMLVideoElement | null>(null);
  // which stream the video got to play: a new stream is not playing until it says so
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
      // a stream: the page holds the player's box from its first paint (WatchPage.tsx)
      state={{ live: true }}
      onClick={onGo}
      draggable={false}
      aria-label={`watch ${name}`}
      className="relative block border border-primaryStroke outline-none transition-[border-color] duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue"
    >
      <StreamStill name={name} className="w-full border-0" />
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
      {/* the home card's chip: the square breathes, the word says it */}
      <span className="absolute left-3 top-3 flex items-center gap-1.5 border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
        <span aria-hidden className="h-2 w-2 animate-pulse bg-increase motion-reduce:animate-none" />
        live
      </span>
    </Link>
  );
}

/**
 * Mounted = shown, the user modal's way: a native <dialog> opened modal on mount, so the
 * browser keeps focus in it, closes it on escape and hands focus back to the row that was
 * clicked; a click on the backdrop closes it too, and so does the page under it changing.
 *
 * What it shows is their watch page without the chat: the head (the face, the name with its
 * marks, the word for how they are, their status), then how many follow them with the follow
 * button, and the button that goes to their page; under those, scrolling, their stream while
 * they are live (`LiveStream`) or the offline picture and line they put up, and the page's
 * three tabs, the same three components: the page of their own, when they stream, where else
 * to find them. A friend has the way to their chat with you, and a popup opened from a chat
 * line the way to that account's lines there, which is what the click did before the popup.
 *
 * It asks nothing the page does not: one profile read (`loadPeek`, the hover card's, kept a
 * short while, so a popup opened off a row whose card was up is whole at once), the tabs'
 * own reads as each is opened, and the name's word from the events socket while it is up, so
 * the stream stands in the popup the moment they start. The row that was clicked gives the
 * face and the ✓ meanwhile.
 */
function ProfileDialog({ target }: { target: ProfilePopupTarget }) {
  const { name } = target;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  /** The press that began this click was on the backdrop too: a text drag that ends outside is not a close. */
  const pressedBackdrop = useRef(false);
  const { pathname } = useLocation();
  /** The page the popup was opened over: the path as it was on the first render, for good. */
  const [openedOn] = useState(pathname);
  const [tab, setTab] = useState<PopupTab>('about');
  /** The profile read did not come. Not an empty page: words, and a way to ask again. */
  const [failed, setFailed] = useState(false);
  const card = useAtomValue(peeksAtom)[name]?.card;
  const heard = useAtomValue(presencesAtom).get(name);
  // the socket's word for them is now's when the page was already keeping it (a roster's member is held by the room), and from the first
  // frame after this popup's own hold otherwise: until then a word the atoms kept from some earlier look may be an old one
  const [trusted, setTrusted] = useState(() => wantsPresence(name));
  // a friend: they follow this login back. the watch page's rule for the line to them (docs/dms.md)
  const friend = useAtomValue(followingAtom)?.find((f) => f.name === name && f.mutual);
  // my own row, or my own name in a chat: the popup is about me, and the button says so
  const mine = useAtomValue(myNameAtom) === name;

  // A layout effect: its cleanup runs while the node is still in the document, which is when
  // close() hands focus back to the opener. (A passive cleanup would run after the removal.)
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // the ×, not the first thing that takes focus: a stray enter closes, and goes nowhere
    closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // the profile read, unless a fresh one is in hand. a read that failed with none kept before it leaves nothing to draw
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

  // their word, as it changes, for as long as the popup is up
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

  // the page under it changed (the browser's back, a link followed): the popup was over that page, and goes with it
  useEffect(() => {
    if (pathname !== openedOn) closeProfilePopup();
  }, [pathname, openedOn]);

  // every way out goes through the element: close() restores focus, then fires `close`
  const close = () => dialogRef.current?.close();

  const presence = (trusted ? heard : undefined) ?? card?.presence;
  const live = presence === 'streaming';
  const verified = card?.verified ?? target.verified;
  const avatar = card ? card.avatar : target.avatar;
  const offline = card?.offline ?? null;
  const socials = useMemo(() => cleanSocials(card?.socials), [card?.socials]);
  // a fake stream gets a page from its name. anyone else's is read from the api (About.tsx)
  const about = useMemo(() => (isDummyName(name) ? dummyPage(name, { offline }) : null), [name, offline]);
  const page = `/watch/${encodeURIComponent(name)}`;

  return (
    <dialog
      ref={dialogRef}
      id="profile-popup"
      data-name={name}
      data-presence={presence}
      aria-labelledby="profile-popup-title"
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) close();
      }}
      onClose={(event) => {
        // a `close` from something inside walks the react tree up to here (UserModal.tsx): not this dialog's
        if (event.target !== event.currentTarget) return;
        closeProfilePopup();
      }}
      className={cn(
        // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop
        'overflow-hidden bg-backgroundSecondary p-0 text-base text-textPrimary',
        'open:flex flex-col',
        // full bleed on a phone: the browser's margins and size caps of a modal dialog go
        'm-0 h-dvh max-h-none w-full max-w-none border-0',
        // past that, as tall as what is in it, between a floor and the window: hung from a fixed top, so a tab with more in it grows the box downward and the head stays put.
        // `h-fit`, not `h-auto`: a modal dialog is pinned top and bottom, and an auto height would stretch between the two
        'sm:mx-auto sm:mb-auto sm:mt-[8dvh] sm:h-fit sm:max-h-[calc(92dvh-1.5rem)] sm:min-h-[min(22rem,calc(92dvh-1.5rem))] sm:w-[min(720px,calc(100vw-3rem))]',
        'sm:border sm:border-primaryStroke',
        'backdrop:bg-black/60 sm:backdrop:backdrop-blur-sm'
      )}
    >
      <header className="flex shrink-0 items-start gap-4 px-5 pt-5">
        <Face name={name} version={avatar} className="h-14 w-14 text-2xl" />
        <div className="min-w-0 flex-1">
          <h2 id="profile-popup-title" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xl leading-tight">
            <Who name={name} verified={verified} />
            {presence && <Word presence={presence} className="font-normal" />}
          </h2>
          {/* their status: the one line about them (`bio` on the wire), a few lines of it here and the whole on hover */}
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
            className="flex h-8 w-8 shrink-0 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue"
          >
            <RiCloseLine aria-hidden size={20} />
          </button>
        </Tooltip>
      </header>

      {/* the watch page's row under the picture: how many follow them and the button to; then the small ways on (a friend's chat, a
          speaker's lines), and at the far end the way to the page itself. not for a fake stream: nobody follows one */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-primaryStroke px-5 py-4">
        {!isDummyName(name) && <FollowButton id="profile-popup-follow" name={name} />}
        {typeof card?.followers === 'number' && !isDummyName(name) && (
          <span id="profile-popup-followers" className="text-textSecondary">
            {card.followers} {card.followers === 1 ? 'follower' : 'followers'}
          </span>
        )}
        {friend && (
          <button
            id="profile-popup-message"
            type="button"
            className={WORDS}
            onClick={() => {
              // the chat window is the page's, under this: the popup makes way for it
              openDm({ id: '', name, avatar: friend.avatar, verified: friend.verified, bio: friend.bio, presence: friend.presence });
              close();
            }}
          >
            message
          </button>
        )}
        {target.lines && (
          <button
            id="profile-popup-lines"
            type="button"
            className={WORDS}
            onClick={() => {
              void showSpeaker(name);
              close();
            }}
          >
            their lines here
          </button>
        )}
        {/* on their page already (a name in their own chat): there is nowhere to go */}
        {openedOn !== page && (
          <Link
            id="profile-popup-page"
            to={page}
            // streaming: the page holds the player's box from its first paint (WatchPage.tsx)
            state={live ? { live: true } : undefined}
            onClick={close}
            draggable={false}
            className={buttonClassName('secondary', 'ml-auto gap-1.5 px-3 py-1.5 text-sm')}
          >
            {mine ? 'go to your page' : 'go to their page'}
            <RiArrowRightLine aria-hidden size={16} />
          </Link>
        )}
      </div>

      {/* `relative`: what is `absolute` or `sr-only` under here has its place inside the scroller (relative-parent.mdc) */}
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
            {/* where the page has its player: the stream, or what they put up for when there is none */}
            {live ? (
              <LiveStream name={name} onGo={close} />
            ) : (
              offline !== null && (
                <img
                  id="profile-popup-offline"
                  src={api.offlineUrl(name, offline)}
                  alt=""
                  draggable={false}
                  className="aspect-video w-full border border-primaryStroke bg-black object-cover"
                />
              )
            )}
            {!live && card.offline_note && (
              <p id="profile-popup-offline-note" className={cn('[overflow-wrap:anywhere]', offline !== null && 'mt-3')}>
                {card.offline_note}
              </p>
            )}

            {/* the page's tabs (WatchPage.tsx), the same three components. a tab's content is only in the popup while it is open */}
            <div id="profile-popup-tabs" className={cn((live || offline !== null || card.offline_note) && 'mt-5')}>
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
                    {/* here since when: the month, in the viewer's time zone; the whole date on hover (the page's socials tab) */}
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

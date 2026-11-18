// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MAX_PICTURE_BYTES } from '@shared/api';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';

// The profile picture (My account): the round initial, or a picture in its place, drawn
// the same size and shape wherever the initial is (My account, Settings' profile card, the
// sidebar, Home's header). It's the Google picture when the sign-in brings one, else the
// initial; tapping it in My account lets the person choose a photo (cropped to a square
// and made small on the device), go back to the Google picture, or to the initial.

setupAppTests();

function withWallet(): FakeServer {
  const server = fakeServer();
  server.accounts.push({
    id: 'a'.repeat(16),
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 10_000,
    position: 0,
    archived: false,
  });
  return server;
}

/** The picture in My account, if one shows */
const myPicture = () => screen.queryByRole('img', { name: 'Your picture' });

/** What the browser hands the app for a photo: decoded at its size, drawn on a canvas */
function stubImages({ width = 1200, height = 800, bytes = 9000, decodes = true } = {}) {
  const drawn: number[][] = [];
  vi.stubGlobal('createImageBitmap', () =>
    decodes ? Promise.resolve({ width, height, close: () => {} }) : Promise.reject(new Error()),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      drawImage: (...args: unknown[]) => drawn.push(args.slice(1).map(Number)),
      fillRect: () => {},
      fillStyle: '',
      imageSmoothingQuality: 'high',
    } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    done: BlobCallback,
    type?: string,
  ) {
    done(new Blob([new Uint8Array(bytes)], { type: type ?? 'image/png' }));
  });
  return { drawn };
}

const photo = () => new File([new Uint8Array(3_000_000)], 'beach.jpg', { type: 'image/jpeg' });

async function openPictureDialog() {
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Change picture' }));
  return within(await screen.findByRole('dialog', { name: 'Profile picture' }));
}

beforeEach(() => {
  stubImages();
});

describe('the profile picture', () => {
  test('is the initial until there is a picture, on a computer', async () => {
    renderApp(withWallet(), '/?settings=account');
    expect(await screen.findByRole('button', { name: 'Change picture' })).toHaveProperty(
      'textContent',
      'R',
    );
    expect(myPicture()).toBeNull();
  });

  test('shows the Google picture in place of every initial, at the same size', async () => {
    const server = withWallet();
    server.me = { ...server.me, picture: { source: 'google', version: 5 }, googlePicture: true };
    renderApp(server, '/');
    // The sidebar's, inside the circle the initial was drawn in
    const sidebar = await screen.findByRole('link', { name: /^Settings: you/ });
    const shown = within(sidebar).getByRole('img', { hidden: true });
    expect(shown.getAttribute('src')).toBe('/api/me/picture?v=google-5');
    expect(shown.parentElement?.textContent).toBe('');
    // And My account's
    await userEvent.setup().click(sidebar);
    const mine = await screen.findByRole('img', { name: 'Your picture' });
    expect(mine.getAttribute('src')).toBe('/api/me/picture?v=google-5');
  });

  test("shows the initial again when a picture can't be loaded", async () => {
    const server = withWallet();
    server.me = { ...server.me, picture: { source: 'upload', version: 9 } };
    renderApp(server, '/?settings=account');
    const mine = await screen.findByRole('img', { name: 'Your picture' });
    mine.dispatchEvent(new Event('error'));
    await waitFor(() => expect(myPicture()).toBeNull());
    expect(screen.getByRole('button', { name: 'Change picture' }).textContent).toBe('R');
  });

  test('a chosen photo is cropped to the middle square, made small, saved and shown', async () => {
    const { drawn } = stubImages({ width: 1200, height: 800 });
    const server = withWallet();
    renderApp(server, '/?settings=account');
    const dialog = await openPictureDialog();
    // Nothing to go back to yet
    expect(dialog.queryByRole('button', { name: 'Use Google picture' })).toBeNull();
    expect(dialog.queryByRole('button', { name: 'Use initial' })).toBeNull();
    expect(dialog.getByText('Cropped to a square and kept small.')).toBeTruthy();

    await userEvent.setup().upload(dialog.getByLabelText('Photo to use'), photo());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The middle 800px square of a 1200 by 800 photo, drawn at 256px
    expect(drawn.at(-1)).toEqual([200, 0, 800, 800, 0, 0, 256, 256]);
    await waitFor(() => expect(server.me.picture?.source).toBe('upload'));
    expect(server.uploads.at(-1)).toMatchObject({ type: 'image/webp', size: 9000 });
    await waitFor(() =>
      expect(myPicture()?.getAttribute('src')).toBe(
        `/api/me/picture?v=upload-${server.me.picture!.version}`,
      ),
    );
  });

  test('a photo still too large once made small is never sent, and says so', async () => {
    stubImages({ bytes: MAX_PICTURE_BYTES + 1 });
    const server = withWallet();
    renderApp(server, '/?settings=account');
    const dialog = await openPictureDialog();
    await userEvent.setup().upload(dialog.getByLabelText('Photo to use'), photo());
    expect(await screen.findByText("That photo couldn't be made small enough.")).toBeTruthy();
    expect(server.uploads).toEqual([]);
    expect(myPicture()).toBeNull();
  });

  test("a photo the browser can't read says so", async () => {
    stubImages({ decodes: false });
    const server = withWallet();
    renderApp(server, '/?settings=account');
    const dialog = await openPictureDialog();
    await userEvent.setup().upload(dialog.getByLabelText('Photo to use'), photo());
    expect(await screen.findByText("Couldn't read that photo.")).toBeTruthy();
    expect(server.uploads).toEqual([]);
  });

  test('a picture the server refuses goes back to what was there, and says why', async () => {
    const server = withWallet();
    server.me = { ...server.me, picture: { source: 'google', version: 5 }, googlePicture: true };
    renderApp(server, '/?settings=account');
    const dialog = await openPictureDialog();
    server.failNext.picture = { status: 415, error: 'Only JPEG, PNG and WebP pictures' };
    await userEvent.setup().upload(dialog.getByLabelText('Photo to use'), photo());
    expect(await screen.findByText('Only JPEG, PNG and WebP pictures')).toBeTruthy();
    await waitFor(() =>
      expect(myPicture()?.getAttribute('src')).toBe('/api/me/picture?v=google-5'),
    );
    expect(server.me.picture).toEqual({ source: 'google', version: 5 });
  });

  test('goes back to the Google picture, or to the initial, on a phone', async () => {
    const server = withWallet();
    server.me = { ...server.me, picture: { source: 'upload', version: 9 }, googlePicture: true };
    renderApp(server, '/?settings=account', { size: 'phone' });
    expect((await screen.findByRole('img', { name: 'Your picture' })).getAttribute('src')).toBe(
      '/api/me/picture?v=upload-9',
    );

    let dialog = await openPictureDialog();
    await userEvent.setup().click(dialog.getByRole('button', { name: 'Use Google picture' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(server.me.picture?.source).toBe('google'));
    expect(myPicture()?.getAttribute('src')).toBe(
      `/api/me/picture?v=google-${server.me.picture!.version}`,
    );

    dialog = await openPictureDialog();
    // Showing it already: only the initial to go to
    expect(dialog.queryByRole('button', { name: 'Use Google picture' })).toBeNull();
    await userEvent.setup().click(dialog.getByRole('button', { name: 'Use initial' }));
    await waitFor(() => expect(myPicture()).toBeNull());
    expect(server.me).toMatchObject({ picture: null, googlePicture: true });
    expect(screen.getByRole('button', { name: 'Change picture' }).textContent).toBe('R');

    // With the initial showing, the Google picture is offered again
    dialog = await openPictureDialog();
    expect(dialog.getByRole('button', { name: 'Use Google picture' })).toBeTruthy();
    expect(dialog.queryByRole('button', { name: 'Use initial' })).toBeNull();
  });

  test('going to the initial shows at once, and comes back if it fails to save', async () => {
    const server = withWallet();
    server.me = { ...server.me, picture: { source: 'upload', version: 9 } };
    renderApp(server, '/?settings=account', { size: 'phone' });
    const dialog = await openPictureDialog();
    server.failNext.profile = 500;
    await userEvent.setup().click(dialog.getByRole('button', { name: 'Use initial' }));
    expect(await screen.findByText("Couldn't change your picture. Try again.")).toBeTruthy();
    await waitFor(() =>
      expect(myPicture()?.getAttribute('src')).toBe('/api/me/picture?v=upload-9'),
    );
    expect(server.me.picture).toEqual({ source: 'upload', version: 9 });
  });

  test("shows on Home's header on a phone, and Settings' profile card", async () => {
    const server = withWallet();
    server.me = { ...server.me, picture: { source: 'upload', version: 9 } };
    renderApp(server, '/', { size: 'phone' });
    const you = await screen.findByRole('link', { name: 'You and settings' });
    expect(within(you).getByRole('img', { hidden: true }).getAttribute('src')).toBe(
      '/api/me/picture?v=upload-9',
    );
    await userEvent.setup().click(you);
    const card = await screen.findByRole('link', { name: /^Ryan ryan@example\.com/ });
    expect(within(card).getByRole('img', { hidden: true }).getAttribute('src')).toBe(
      '/api/me/picture?v=upload-9',
    );
  });
});

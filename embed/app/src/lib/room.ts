import { Room, RoomEvent, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { encodeClientFrame, parseWorkerFrame, type ClientFrame, type WorkerFrame } from './frames.ts';

// Подписка/публикация трека НЕ решаются здесь: решение (гасить видео, прикреплять
// аудио) принимает App через onPublication/onTrack. Так его видно в юнит-тестах,
// где комната замокана и реальные RoomEvent'ы не летят.
export type CorePublication = { kind: string; setSubscribed(subscribed: boolean): void };
export type CoreTrack = { kind: string; attach(): HTMLMediaElement };

export type CoreRoomHandlers = {
  onFrame: (frame: WorkerFrame) => void;
  onAgentJoined: () => void;
  onDisconnected: () => void;
  onPublication?: (pub: CorePublication) => void;
  onTrack?: (track: CoreTrack) => void;
};

export class CoreRoom {
  private room: Room | null = null;

  constructor(private readonly handlers: CoreRoomHandlers) {}

  async connect(url: string, token: string, opts: { audio: boolean }): Promise<void> {
    const room = new Room();
    this.room = room;
    room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      const frame = parseWorkerFrame(payload);
      if (frame) this.handlers.onFrame(frame);
    });
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      if (p.identity.startsWith('agent-')) this.handlers.onAgentJoined();
    });
    room.on(RoomEvent.Disconnected, () => this.handlers.onDisconnected());
    if (opts.audio) {
      // Публикацию/трек не трогаем сами — отдаём App: он гасит видео и
      // прикрепляет аудио. UI аудио-only, «просто не рисовать» видео мало —
      // подписка живёт и трафик оплачивается, пока её не снять.
      room.on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication) => this.handlers.onPublication?.(pub));
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => this.handlers.onTrack?.(track));
    }
    await room.connect(url, token);
    // Агент мог войти РАНЬШЕ нас — событие для него не придёт.
    for (const p of room.remoteParticipants.values()) {
      if (p.identity.startsWith('agent-')) this.handlers.onAgentJoined();
    }
    if (opts.audio) await room.startAudio().catch(() => undefined); // autoplay-политика
  }

  publish(frame: ClientFrame): void {
    // publishData при room=null — молчаливая потеря фрейма; шумим в консоль.
    if (!this.room) { console.warn('[aski] фрейм в никуда: комнаты нет', frame.type); return; }
    void this.room.localParticipant.publishData(encodeClientFrame(frame), { reliable: true });
  }

  async setMicrophoneEnabled(on: boolean): Promise<void> {
    if (!this.room) throw new Error('микрофон без комнаты не включить');
    await this.room.localParticipant.setMicrophoneEnabled(on);
  }

  async disconnect(): Promise<void> {
    await this.room?.disconnect();
    this.room = null;
  }
}

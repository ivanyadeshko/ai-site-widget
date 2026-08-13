import { Room, RoomEvent, type RemoteParticipant } from 'livekit-client';
import { encodeClientFrame, parseWorkerFrame, type ClientFrame, type WorkerFrame } from './frames.ts';

export class CoreRoom {
  private room: Room | null = null;
  private readonly audio = new Set<HTMLMediaElement>();

  constructor(
    private readonly handlers: {
      onFrame: (frame: WorkerFrame) => void;
      onAgentJoined: () => void;
      onDisconnected: () => void;
    },
  ) {}

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
      room.on(RoomEvent.TrackSubscribed, (track) => {
        // Подписка ≠ воспроизведение: без attach() голос молчит (урок монолита).
        if (track.kind !== 'audio') { void track; return; }
        const element = track.attach();
        element.autoplay = true;
        document.body.appendChild(element);
        this.audio.add(element);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        for (const element of track.detach()) { element.remove(); this.audio.delete(element); }
      });
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
    for (const element of this.audio) element.remove();
    this.audio.clear();
    await this.room?.disconnect();
    this.room = null;
  }
}

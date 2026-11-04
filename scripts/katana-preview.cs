// Katana's instant dictation words: Windows' classic speech engine (System.Speech),
// which runs entirely on this PC, so nothing leaves it (unlike the newer Windows
// engine in katana-speech.cs, which sends your voice to Microsoft). It's less
// accurate than Canary but hears as you speak: its words show at once, and Canary's
// replace them when you pause.
//
// Compiled once with the C# compiler Windows ships, and run while the mic is on.
// One line per event on stdout:
//   READY                 listening
//   PARTIAL <tab> text    the words so far in what's being said
//   FINAL <tab> text      what it settled on for what was said
//   ERROR <tab> message   something went wrong (then it exits)
// It stops when stdin closes or the process is killed.
//
// --wav <file>: hears a 16-bit PCM WAV file in real time instead of the mic (for tests).

using System;
using System.IO;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Threading;

static class KatanaPreview
{
    static readonly object Gate = new object();

    static void Emit(string kind, string text)
    {
        lock (Gate)
        {
            string clean = (text ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
            Console.Out.WriteLine(clean.Length > 0 ? kind + "\t" + clean : kind);
            Console.Out.Flush();
        }
    }

    // A file read no faster than it would be spoken, then endless silence.
    sealed class RealTime : Stream
    {
        readonly byte[] data;
        readonly int bytesPerSecond;
        readonly DateTime started = DateTime.UtcNow;
        int at;

        public RealTime(byte[] data, int bytesPerSecond)
        {
            this.data = data;
            this.bytesPerSecond = bytesPerSecond;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            // (The whole amount asked for: the engine takes less as the end of the audio.)
            double due = (double)(at + count) / bytesPerSecond;
            double ahead = due - (DateTime.UtcNow - started).TotalSeconds;
            if (ahead > 0) Thread.Sleep((int)(ahead * 1000));
            int real = Math.Min(count, Math.Max(0, data.Length - at));
            if (real > 0) Array.Copy(data, at, buffer, offset, real);
            if (count > real) Array.Clear(buffer, offset + real, count - real);
            at += count;
            return count;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return long.MaxValue; } }
        public override long Position { get { return at; } set { } }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) { return at; }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }

    static void HearFile(SpeechRecognitionEngine engine, string file)
    {
        byte[] all = File.ReadAllBytes(file);
        int channels = BitConverter.ToInt16(all, 22);
        int rate = BitConverter.ToInt32(all, 24);
        int bits = BitConverter.ToInt16(all, 34);
        int data = 12;
        while (data + 8 < all.Length && !(all[data] == 'd' && all[data + 1] == 'a' && all[data + 2] == 't' && all[data + 3] == 'a'))
        {
            data += 8 + BitConverter.ToInt32(all, data + 4);
        }
        int length = Math.Min(BitConverter.ToInt32(all, data + 4), all.Length - data - 8);
        byte[] samples = new byte[length];
        Array.Copy(all, data + 8, samples, 0, length);
        int perSecond = rate * channels * bits / 8;
        engine.SetInputToAudioStream(
            new RealTime(samples, perSecond),
            new SpeechAudioFormatInfo(rate, bits == 8 ? AudioBitsPerSample.Eight : AudioBitsPerSample.Sixteen, channels == 1 ? AudioChannel.Mono : AudioChannel.Stereo));
    }

    static int Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        try
        {
            using (SpeechRecognitionEngine engine = new SpeechRecognitionEngine())
            {
                engine.LoadGrammar(new DictationGrammar());
                engine.SpeechHypothesized += (sender, e) => Emit("PARTIAL", e.Result.Text);
                engine.SpeechRecognized += (sender, e) => Emit("FINAL", e.Result.Text);
                if (args.Length == 2 && args[0] == "--wav") HearFile(engine, args[1]);
                else engine.SetInputToDefaultAudioDevice();
                engine.RecognizeAsync(RecognizeMode.Multiple);
                Emit("READY", "");
                while (Console.In.Read() != -1) { }
                engine.RecognizeAsyncCancel();
            }
            return 0;
        }
        catch (Exception error)
        {
            Emit("ERROR", error.Message);
            return 1;
        }
    }
}

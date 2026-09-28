using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

internal static class NativeUpdateHost
{
    private const int MaxMessageBytes = 1024 * 1024;
    private const int ProcessTimeoutMs = 300000;
    private const string RepoPath = @"D:\EZ-Reader";

    private sealed class ProcessResult
    {
        public int ExitCode;
        public string Output;
    }

    private static int Main()
    {
        try
        {
            string request = ReadRequest(Console.OpenStandardInput());
            if (request == null || !Regex.IsMatch(request, "\"action\"\\s*:\\s*\"update\"")) return 0;
            RunUpdate();
        }
        catch
        {
            SendResult(false, "本地更新辅助程序运行失败。", "");
        }
        return 0;
    }

    private static string ReadRequest(Stream input)
    {
        byte[] header = new byte[4];
        if (!ReadExact(input, header, 4)) return null;
        int length = BitConverter.ToInt32(header, 0);
        if (length <= 0 || length > MaxMessageBytes) return null;
        byte[] body = new byte[length];
        if (!ReadExact(input, body, length)) return null;
        return Encoding.UTF8.GetString(body);
    }

    private static bool ReadExact(Stream input, byte[] buffer, int length)
    {
        int offset = 0;
        while (offset < length)
        {
            int count = input.Read(buffer, offset, length - offset);
            if (count <= 0) return false;
            offset += count;
        }
        return true;
    }

    private static void RunUpdate()
    {
        string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.txt");
        string[] config = File.ReadAllLines(configPath, Encoding.UTF8);
        if (config.Length < 2) throw new InvalidOperationException("配置不完整。");
        string repo = RepoPath;
        string git = Path.GetFullPath(config[0].Trim());
        string node = Path.GetFullPath(config[1].Trim());
        if (!Directory.Exists(repo) || !File.Exists(git) || !File.Exists(node))
            throw new InvalidOperationException("仓库或运行时路径无效。");

        SendPhase("检查源码仓库…");
        ProcessResult status = RunProcess(git, "-C " + QuoteArgument(repo) + " status --porcelain --untracked-files=normal", repo);
        if (status.ExitCode != 0)
        {
            SendResult(false, "无法读取 Git 仓库状态，请检查 Git 安装和仓库配置。", "");
            return;
        }
        if (!String.IsNullOrWhiteSpace(status.Output))
        {
            SendResult(false, "源码仓库有未提交的改动；请先处理这些改动，再检查更新。", "");
            return;
        }

        SendPhase("正在从 Git 更新源码…");
        ProcessResult pull = RunProcess(git, "-C " + QuoteArgument(repo) + " pull --ff-only", repo);
        if (pull.ExitCode != 0)
        {
            SendResult(false, "Git 更新未完成。请检查远端分支、网络或认证配置后重试。", "");
            return;
        }

        SendPhase("正在构建并同步 dist/extension 差异…");
        ProcessResult build = RunProcess(node, QuoteArgument(Path.Combine(repo, "tools", "build.js")), repo);
        if (build.ExitCode != 0)
        {
            SendResult(false, "源码已更新，但构建失败。请检查本地 Node.js 环境和构建输出。", "");
            return;
        }

        string infoPath = Path.Combine(repo, "dist", "extension", "build-info.json");
        string version = "";
        if (File.Exists(infoPath))
        {
            string text = File.ReadAllText(infoPath, Encoding.UTF8);
            Match match = Regex.Match(text, "\"version\"\\s*:\\s*\"([^\"]+)\"");
            if (match.Success) version = match.Groups[1].Value;
        }
        SendResult(true, "Git 更新和构建完成。", version);
    }

    private static ProcessResult RunProcess(string executable, string arguments, string workingDirectory)
    {
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = executable;
        start.Arguments = arguments;
        start.WorkingDirectory = workingDirectory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.WindowStyle = ProcessWindowStyle.Hidden;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.RedirectStandardInput = true;
        start.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";
        start.StandardOutputEncoding = Encoding.UTF8;
        start.StandardErrorEncoding = Encoding.UTF8;

        using (Process process = new Process())
        {
            process.StartInfo = start;
            if (!process.Start()) throw new InvalidOperationException("无法启动本地命令。");
            Task<string> stdout = process.StandardOutput.ReadToEndAsync();
            Task<string> stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(ProcessTimeoutMs))
            {
                try { process.Kill(); } catch { }
                throw new TimeoutException("本地更新操作超时。");
            }
            Task.WaitAll(stdout, stderr);
            return new ProcessResult { ExitCode = process.ExitCode, Output = stdout.Result + "\n" + stderr.Result };
        }
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void SendPhase(string message)
    {
        SendJson("{\"type\":\"phase\",\"message\":" + JsonString(message) + "}");
    }

    private static void SendResult(bool ok, string message, string version)
    {
        SendJson("{\"type\":\"result\",\"ok\":" + (ok ? "true" : "false") +
            ",\"message\":" + JsonString(message) + ",\"version\":" + JsonString(version) + "}");
    }

    private static void SendJson(string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        byte[] header = BitConverter.GetBytes(payload.Length);
        Stream output = Console.OpenStandardOutput();
        output.Write(header, 0, header.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }

    private static string JsonString(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        foreach (char character in value ?? "")
        {
            switch (character)
            {
                case '"': result.Append("\\\""); break;
                case '\\': result.Append("\\\\"); break;
                case '\b': result.Append("\\b"); break;
                case '\f': result.Append("\\f"); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 0x20) result.Append("\\u" + ((int)character).ToString("x4"));
                    else result.Append(character);
                    break;
            }
        }
        result.Append('"');
        return result.ToString();
    }
}

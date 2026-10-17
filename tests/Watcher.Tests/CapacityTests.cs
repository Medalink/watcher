namespace Watcher.Tests;

public sealed class CapacityTests
{
    [Fact]
    public void The_probe_reads_the_processor_count_and_mem_total_in_kib()
    {
        Assert.Equal(new Capacity(32, 49_280_122_880), Capacity.Parse("32\nMemTotal:       48125120 kB\n"));
        Assert.Equal(new Capacity(4, 8_388_608), Capacity.Parse("4\r\nMemTotal: 8192 kB\r\n"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("sh: not found")]
    [InlineData("OCI runtime exec failed: exec: \"sh\": executable file not found in $PATH")]
    [InlineData("32\n")]
    [InlineData("0\nMemTotal:       48125120 kB")]
    [InlineData("MemTotal:       48125120 kB\n32")]
    [InlineData("32\nMemTotal:       lots kB")]
    [InlineData("32\nMemTotal:       48125120 MB")]
    public void Anything_else_is_no_measurement(string output)
    {
        Assert.Null(Capacity.Parse(output));
    }

    [Fact]
    public void Windows_stands_in_until_wsl_is_measured()
    {
        var windows = new Capacity(32, 100_605_000_000);
        var wsl = new Capacity(16, 49_280_122_880);

        Assert.Equal(new Capacities(windows, windows, WslMeasured: false), Capacities.Unmeasured(windows));
        Assert.Equal(new Capacities(wsl, windows, WslMeasured: true), Capacities.Unmeasured(windows).Measured(wsl));
    }
}

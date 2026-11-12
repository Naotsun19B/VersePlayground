# Learning sample: copy, modify and reuse it freely. No attribution needed.

# Shows Sleep and the clock of /Verse.org/Simulation: waiting in real time, a timeout made with race, tasks that
# wait side by side in sync, and a task started with spawn.
# GetSimulationElapsedTime returns the seconds since the script started. As within one frame in UEFN, the clock
# only moves while the script waits, so two calls with no Sleep between them return the same time.

using { /Verse.org/Simulation }

Main(Args:[]string, Env:[string]string)<suspends>:void =
    Print("Counting down:")
    for (Step := 0..2):
        Print("  {3 - Step}")
        Sleep(1.0)
    Print("  Go! ({FormatSeconds(GetSimulationElapsedTime())})")

    # race cancels the slower task, so a Sleep in a race is a timeout for the other task.
    Print("A task that takes 2 seconds, with a 0.5 second timeout:")
    Outcome := race:
        block:
            Sleep(2.0)
            "finished"
        block:
            Sleep(0.5)
            "timed out"
    Print("  It {Outcome} ({FormatSeconds(GetSimulationElapsedTime())})")

    # sync waits for every task. Their Sleep calls overlap, so this takes as long as the slowest one.
    Print("Two tasks that wait side by side:")
    StartTime := GetSimulationElapsedTime()
    sync:
        Repeat("pasta", 3, 0.4)
        Repeat("sauce", 2, 0.5)
    Print("  Both done after {FormatSeconds(GetSimulationElapsedTime() - StartTime)}")

    # A spawned task runs on its own while Main goes on, and stops when Main returns.
    Print("A spawned heartbeat while Main sleeps for 1 second:")
    spawn{ Heartbeat() }
    Sleep(1.0)
    Print("  Main ends here, and the heartbeat ends with it")

# Prints Name Times times, waiting Seconds before each line.
Repeat(Name:string, Times:int, Seconds:float)<suspends>:void =
    for (Count := 1..Times):
        Sleep(Seconds)
        Print("  {Name} {Count} ({FormatSeconds(GetSimulationElapsedTime())})")

# Prints a line every 0.3 seconds. It never returns by itself; it stops when the program ends.
Heartbeat()<suspends>:void =
    loop:
        Sleep(0.3)
        Print("  beat ({FormatSeconds(GetSimulationElapsedTime())})")

# Shows Seconds with one decimal place, such as "1.5 s".
# Round fails only for a value too large for an int, and Quotient and Mod fail only when they divide by zero.
# FormatSeconds is <reads> because Round is.
FormatSeconds(Seconds:float)<reads>:string =
    if (Tenths := Round[Seconds * 10.0], Whole := Quotient[Tenths, 10], Fraction := Mod[Tenths, 10]):
        "{Whole}.{Fraction} s"
    else:
        "{Seconds} s"

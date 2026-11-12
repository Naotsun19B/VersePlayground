# Shows structured concurrency with race and sync.
# Functions marked <suspends> can wait. Yield() waits until the next update, which lets the other running tasks
# take their turn, so the output of the tasks below is interleaved.

Main(Args:[]string, Env:[string]string)<suspends>:void =
    # race runs both tasks at the same time. When the first one finishes, the other is cancelled and race returns
    # the result of the finished one.
    Winner := race:
        Countdown("slow", 5)
        Countdown("fast", 2)
    Print("race winner: {Winner}")

    # sync also runs both tasks at the same time, but waits for all of them and returns their results as a tuple.
    Results := sync:
        Countdown("left", 2)
        Countdown("right", 3)
    Print("sync finished: {Results(0)} and {Results(1)}")

# Prints one line per step, waiting for the next update between steps, and returns Name when it is done.
Countdown(Name:string, Steps:int)<suspends>:string =
    for (Step := 1..Steps):
        Print("  {Name}: step {Step}")
        Yield()
    Name

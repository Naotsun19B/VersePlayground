# Shows how Verse handles expressions that can fail.
# Instead of exceptions or sentinel values, an expression that can fail is only allowed inside a failure context,
# such as the condition of an if. When it fails, the context fails and the else branch runs.

Main(Args:[]string, Env:[string]string)<suspends>:void =
    Numbers := array{10, 20, 30}

    if (Value := Numbers[1]):
        Print("Numbers[1] is {Value}")

    if (Value := Numbers[5]):
        Print("Numbers[5] is {Value}")
    else:
        Print("Numbers[5] failed because Numbers has only {Numbers.Length} elements")

    # Every expression in one failure context has to succeed. If the comparison fails, the bindings before it
    # are discarded as well.
    if (First := Numbers[0], Last := Numbers[Numbers.Length - 1], First < Last):
        Print("The first element {First} is smaller than the last element {Last}")

    # A function marked <decides> can fail, so it is called with [] and only inside a failure context.
    for (Name : array{"Verse", ""}):
        if (Initial := GetInitial[Name]):
            Print("The initial of \"{Name}\" is {Initial}")
        else:
            Print("An empty name has no initial")

# Returns the first character of Name. Fails when Name is empty, because there is no character to return.
GetInitial(Name:string)<computes><decides>:char =
    Name[0]

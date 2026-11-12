# Learning sample: copy, modify and reuse it freely. No attribution needed.

# Asks for your name on standard input and greets you.
# Run it with:  verse.exe Greeting.verse
# In VS Code, the run button starts it in the terminal, so you can type your name there.

# Reads lines until a non-empty one arrives and returns it.
# InputLine returns an empty option when the input ends (Ctrl+Z then Enter in a Windows console, or the end of a
# piped file), so this function returns ?string as well instead of asking forever.
ReadName()<suspends>:?string =
    loop:
        Print("What is your name?")

        # InputLine waits for the user, which is a <suspends> call, and those cannot run inside a failure context
        # such as an if condition. Read the line first and look inside the option afterwards.
        MaybeLine := InputLine()
        if (Line := MaybeLine?):
            # A string is an array of characters, so Length counts them. An empty line asks again.
            if (Line.Length > 0):
                return option{Line}
            Print("Please type at least one character.")
        else:
            return false

Main(Args:[]string, Env:[string]string)<suspends>:void =
    # MaybeName? fails when the option is empty, and then the else branch runs.
    MaybeName := ReadName()
    if (Name := MaybeName?):
        Print("Hello, {Name}! Nice to meet you.")
    else:
        Print("No name was entered.")

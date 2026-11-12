# Learning sample: copy, modify and reuse it freely. No attribution needed.

# The smallest Verse program that verse.exe can run.
# verse.exe calls Main with the command-line arguments and the environment variables, and waits until it returns.
# Run it with:  verse.exe HelloWorld.verse [Name]

Main(Args:[]string, Env:[string]string)<suspends>:void =
    # Args[0] is the path of this script, and the arguments after the script path follow it.
    # Indexing past the end of an array fails instead of crashing, so the else branch runs when no name is given.
    if (Name := Args[1]):
        Print("Hello, {Name}!")
    else:
        Print("Hello, World!")

# Learning sample: copy, modify and reuse it freely. No attribution needed.

# Shows a struct, a class with methods, a <constructor> function and a failable method working together, with a
# small random number generator.
# Run it with:  verse.exe Random.verse [Seed]

# What a generator remembers between calls. A struct is a value: copying it copies the numbers, and changing a
# generator's state means replacing the whole struct.
generator_state := struct:
    Seed:int = 0
    Count:int = 0

# A linear congruential generator. It is not good enough for games of chance, but it is short and gives the same
# numbers for the same seed, which makes runs repeatable.
random_generator := class:
    var State:generator_state = generator_state{}

    # Returns the next number, from 0 to 2^31 - 1. Changing a var field needs the <transacts> effect.
    Next()<transacts>:int =
        NextSeed := Wrap(State.Seed * 1103515245 + 12345)
        set State = generator_state:
            Seed := NextSeed
            Count := State.Count + 1
        NextSeed

    # Returns a number from Low to High. It fails when Low is greater than High, so call it in a failure context,
    # with square brackets. A call that fails also takes back the number it drew.
    NextInRange(Low:int, High:int)<transacts><decides>:int =
        Low <= High
        Low + Mod[Next(), High - Low + 1]

    # How many numbers this generator has returned.
    CallCount()<reads>:int = State.Count

    # Keeps the lowest 31 bits. <private> hides it from code outside the class.
    # Mod fails only when it divides by zero, so the "or 0" is never used.
    Wrap<private>(Value:int)<computes>:int = (Mod[Value, 2147483648] or 0)

# Spreads the bits of a seed, so that seeds 1 and 2 do not start with similar numbers.
# Mod fails only when it divides by zero, so the "or 0" is never used. It has no <computes> because a local var
# needs more effects than <computes> allows.
MixSeed(Seed:int):int =
    var Mixed:int = Seed
    for (Pass := 1..3):
        set Mixed = (Mod[Mixed * 2654435761 + Pass, 2147483648] or 0)
    Mixed

# A <constructor> function creates an instance, like random_generator{...}, but can run code first.
MakeRandomGenerator<constructor>(Seed:int) := random_generator:
    State := generator_state{Seed := MixSeed(Seed)}

# Reads a whole number such as "42" or "-7". It fails when Text is empty or has anything but digits after an
# optional minus sign, so call it in a failure context. It has <transacts> because it changes local vars, which a
# failure takes back.
ParseInt(Text:string)<transacts><decides>:int =
    var Sign:int = 1
    var Digits:string = Text
    if (Text[0] = '-', Rest := Text.Slice[1]):
        set Sign = -1
        set Digits = Rest
    Digits.Length > 0
    # A for with a failing filter skips that element, so a non-digit makes the result shorter than Digits.
    DigitValues := for (Char : Digits, Digit := "0123456789".Find[Char]):
        Digit
    DigitValues.Length = Digits.Length
    var Value:int = 0
    for (Digit : DigitValues):
        set Value = Value * 10 + Digit
    Sign * Value

Main(Args:[]string, Env:[string]string)<suspends>:void =
    # Without an argument, the generators use fixed seeds, so every run prints the same numbers.
    var PairSeed:int = 42
    var DiceSeed:int = 7
    if (Arg := Args[1]):
        if (Seed := ParseInt[Arg]):
            set PairSeed = Seed
            set DiceSeed = Seed
            Print("Seed: {Seed}")
        else:
            Print("'{Arg}' is not a whole number, so the fixed seeds are used.")

    Print("The same seed gives the same numbers:")
    First := MakeRandomGenerator(PairSeed)
    Second := MakeRandomGenerator(PairSeed)
    for (Index := 1..3):
        Print("  {First.Next()} {Second.Next()}")

    Print("Five dice rolls:")
    Dice := MakeRandomGenerator(DiceSeed)
    for (Index := 1..5):
        if (Roll := Dice.NextInRange[1, 6]):
            Print("  {Roll}")

    if (Dice.NextInRange[6, 1]):
        Print("A range from 6 to 1 should have failed.")
    else:
        Print("A range from 6 to 1 fails.")

    Print("The dice generator returned {Dice.CallCount()} numbers.")

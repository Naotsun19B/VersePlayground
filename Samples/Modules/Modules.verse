# Learning sample: copy, modify and reuse it freely. No attribution needed.

# Shows a module and a class hierarchy in one file.
# verse.exe cannot load modules from other folders yet, so a module that other code uses has to be defined in the
# same file as Main.

Shapes := module:
    # The base type of every shape. It is abstract, so only its subclasses can be created.
    shape<public> := class<abstract>:
        Area<public>()<computes>:float

    square<public> := class(shape):
        Side<public>:float = 1.0

        Area<override>()<computes>:float = Side * Side

    rectangle<public> := class(shape):
        Width<public>:float = 1.0
        Height<public>:float = 1.0

        Area<override>()<computes>:float = Width * Height

    # Builds the line printed for each shape. It has no access specifier, so code outside Shapes cannot call it.
    # Converting a float to a string has the <reads> effect, so this function and its caller need <reads>
    # even though they only compute a value.
    FormatArea(Shape:shape)<reads>:string =
        "area {Shape.Area()}"

    Describe<public>(Name:string, Shape:shape)<reads>:string =
        "{Name}: {FormatArea(Shape)}"

Main(Args:[]string, Env:[string]string)<suspends>:void =
    Print(Shapes.Describe("square", Shapes.square{Side := 3.0}))
    Print(Shapes.Describe("rectangle", Shapes.rectangle{Width := 2.0, Height := 5.0}))

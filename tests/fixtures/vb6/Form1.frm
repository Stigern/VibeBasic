VERSION 5.00
Object = "{831FDD16-0C5C-11D2-A9FC-0000F8754DA1}#2.0#0"; "MSCOMCTL.OCX"
Begin VB.Form Form1 
   Caption         =   "Blåbærsyltetøy"
   ClientHeight    =   3195
   ClientLeft      =   165
   ClientTop       =   855
   ClientWidth     =   4680
   BeginProperty Font 
      Name            =   "Arial"
      Size            =   9.75
      Charset         =   0
      Weight          =   700
      Underline       =   0   'False
      Italic          =   -1  'True
      Strikethrough   =   0   'False
   EndProperty
   LinkTopic       =   "Form1"
   ScaleHeight     =   3195
   ScaleWidth      =   4680
   StartUpPosition =   2  'CenterScreen
   Begin MSComctlLib.ProgressBar ProgressBar1 
      Height          =   255
      Left            =   120
      TabIndex        =   5
      Top             =   2760
      Width           =   2055
      _ExtentX        =   3625
      _ExtentY        =   450
      _Version        =   393216
      Appearance      =   1
   End
   Begin Foo.Gadget Gadget1 
      Height          =   495
      Left            =   3000
      TabIndex        =   4
      Top             =   2520
      Width           =   1215
   End
   Begin VB.ListBox List1 
      Height          =   645
      Left            =   3000
      List            =   "Form1.frx":0052
      TabIndex        =   3
      Top             =   1680
      Width           =   1455
   End
   Begin VB.TextBox Text1 
      Height          =   495
      Left            =   3000
      MultiLine       =   -1  'True
      TabIndex        =   2
      Text            =   "Form1.frx":0067
      Top             =   1080
      Width           =   1455
   End
   Begin VB.PictureBox Picture1 
      BackColor       =   &H00FFFFFF&
      Height          =   735
      Left            =   3000
      Picture         =   "Form1.frx":0000
      ScaleHeight     =   675
      ScaleWidth      =   1395
      TabIndex        =   1
      Top             =   120
      Width           =   1455
   End
   Begin VB.Frame Frame1 
      Caption         =   "Ytre"
      Height          =   2535
      Left            =   120
      TabIndex        =   0
      Top             =   120
      Width           =   2655
      Begin VB.Frame Frame2 
         Caption         =   "Indre"
         Height          =   1815
         Left            =   120
         TabIndex        =   6
         Top             =   360
         Width           =   2295
         Begin VB.OptionButton Option1 
            Caption         =   "Nei"
            Height          =   255
            Index           =   1
            Left            =   120
            TabIndex        =   8
            Top             =   720
            Width           =   1335
         End
         Begin VB.OptionButton Option1 
            Caption         =   "Ja"
            Height          =   255
            Index           =   0
            Left            =   120
            TabIndex        =   7
            Top             =   360
            Value           =   -1  'True
            Width           =   1335
         End
      End
   End
   Begin VB.Menu mnuFile 
      Caption         =   "&Fil"
      Begin VB.Menu mnuOpen 
         Caption         =   "&Åpne..."
         Shortcut        =   ^O
      End
      Begin VB.Menu mnuSep 
         Caption         =   "-"
      End
      Begin VB.Menu mnuExit 
         Caption         =   "&Avslutt"
      End
   End
End
Attribute VB_Name = "Form1"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False
Option Explicit
Private Declare Function GetTickCount Lib "kernel32" () As Long

Private Sub Form_Load()
    Text1.Text = "Hei på deg"
End Sub
